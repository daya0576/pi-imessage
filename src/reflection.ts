/**
 * Nightly reflection over chat logs, Atom feeds, and GitHub events.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	assertSkillName,
	createHarnessSnapshot,
	deleteSkill,
	deleteSystemNote,
	formatSkillCatalog,
	listSkillCatalog,
	readSystemNotes,
	rollbackSnapshot,
	upsertSystemNote,
	writeSkill,
} from "./harness.js";
import { MEMORY_KINDS, activeMemoryItems, loadAllMemoryItems, saveMemory } from "./memory.js";
import type { MemoryKind, SaveMemoryInput } from "./memory.js";
import {
	type CollectSourcesInput,
	type ReflectionSourceItem,
	type SourceCheckpoints,
	collectReflectionSources,
	emptySourceCheckpoints,
	formatSourceItemsForPrompt,
} from "./reflection-sources.js";
import { type ReflectionSettings, readSettings } from "./settings.js";
import { listChatGuids } from "./store.js";

const CHECKPOINT_VERSION = 2;
const MAX_MEMORIES_IN_PROMPT = 80;
const MAX_MEMORY_WRITES = 15;
const MAX_NOTE_WRITES = 5;
const MAX_SKILL_WRITES = 3;
const REFLECTION_TIMEOUT_MS = 180_000;
const LOCK_TIMEOUT_MS = 5 * 60_000;

export interface ReflectionCheckpoint extends SourceCheckpoints {
	version: number;
	lastRunAt: string | null;
	lastSnapshotId: string | null;
	lastSummary: string | null;
}

export interface ReflectionProposal {
	summary: string;
	memories: ReflectionMemoryProposal[];
	prompt_notes: ReflectionNoteProposal[];
	skills: ReflectionSkillProposal[];
}

export interface ReflectionMemoryProposal {
	text: string;
	namespace: string;
	kind: MemoryKind;
	subjects: string[];
	event_time: string | null;
	importance: number;
	confidence: number;
	supersedes_id?: string;
}

export interface ReflectionNoteProposal {
	action: "create" | "update" | "delete";
	scope: "global" | "chat";
	chat_guid?: string;
	id?: string;
	text?: string;
}

export interface ReflectionSkillProposal {
	action: "create" | "update" | "delete";
	name: string;
	scope: "global" | "chat";
	chat_guid?: string;
	description?: string;
	instructions?: string;
}

export interface ReflectionResult {
	ok: boolean;
	initialized?: boolean;
	skipped?: boolean;
	summary: string;
	snapshotId: string | null;
	memoriesAdded: number;
	notesChanged: number;
	skillsChanged: number;
	chats: number;
	chatMessages: number;
	atom: number;
	github: number;
	error?: string;
}

export type ReflectionLlm = (input: ReflectionPromptInput) => Promise<ReflectionProposal>;

export interface ReflectionPromptInput {
	items: ReflectionSourceItem[];
	memories: Array<{ id: string; namespace: string; kind: string; text: string; event_time: string | null }>;
	skills: string;
	notes: string;
	sources: { atomFeeds: string[]; githubUser: string };
}

export function checkpointPath(workingDir: string): string {
	return join(workingDir, "harness", "checkpoint.json");
}

export function reflectionHistoryPath(workingDir: string): string {
	return join(workingDir, "harness", "history.jsonl");
}

export function emptyCheckpoint(): ReflectionCheckpoint {
	return {
		version: CHECKPOINT_VERSION,
		lastRunAt: null,
		lastSnapshotId: null,
		lastSummary: null,
		...emptySourceCheckpoints(),
	};
}

export function readCheckpoint(workingDir: string): ReflectionCheckpoint {
	const path = checkpointPath(workingDir);
	if (!existsSync(path)) return emptyCheckpoint();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReflectionCheckpoint>;
		return {
			version: CHECKPOINT_VERSION,
			lastRunAt: parsed.lastRunAt ?? null,
			lastSnapshotId: parsed.lastSnapshotId ?? null,
			lastSummary: parsed.lastSummary ?? null,
			chats: parsed.chats ?? {},
			atom: readAtomCheckpoint(parsed.atom),
			github: { seenIds: Array.isArray(parsed.github?.seenIds) ? parsed.github.seenIds : [] },
		};
	} catch (error) {
		console.warn(`[reflection] failed to read checkpoint: ${error}`);
		return emptyCheckpoint();
	}
}

export function formatReflectionSummary(result: ReflectionResult): string {
	if (!result.ok) return `✗ Reflection failed: ${result.error ?? "unknown error"}`;
	if (result.initialized) return "✓ Reflection checkpoint initialized — new signals will be reviewed tonight";
	if (result.skipped) return "✓ Reflection: no new chat / atom / GitHub signals";
	const snapshot = result.snapshotId ? `\nsnapshot ${result.snapshotId}` : "";
	return (
		`✓ Reflection: chat ${result.chatMessages}, atom ${result.atom}, github ${result.github}\n` +
		`memories +${result.memoriesAdded}, notes ${result.notesChanged}, skills ${result.skillsChanged}${snapshot}`
	);
}

export function msUntilLocalHour(hour: number, now = new Date()): number {
	const next = new Date(now);
	next.setHours(hour, 0, 0, 0);
	if (next.getTime() <= now.getTime()) {
		next.setDate(next.getDate() + 1);
		next.setHours(hour, 0, 0, 0);
	}
	return next.getTime() - now.getTime();
}

export function shouldCatchUpReflection(checkpoint: ReflectionCheckpoint, hour: number, now = new Date()): boolean {
	if (!checkpoint.lastRunAt) return false;
	const todayAtHour = new Date(now);
	todayAtHour.setHours(hour, 0, 0, 0);
	if (now.getTime() < todayAtHour.getTime()) return false;
	return new Date(checkpoint.lastRunAt).getTime() < todayAtHour.getTime();
}

export async function runReflection(
	workingDir: string,
	options: {
		llm?: ReflectionLlm;
		now?: Date;
		trigger?: string;
		fetchers?: CollectSourcesInput["fetchers"];
	} = {}
): Promise<ReflectionResult> {
	return withReflectionLock(workingDir, async () => {
		const now = options.now ?? new Date();
		const trigger = options.trigger ?? "nightly-reflection";
		const settings = reflectionSettings(workingDir);
		const checkpoint = readCheckpoint(workingDir);
		const hadCheckpointFile = existsSync(checkpointPath(workingDir));

		let collected: Awaited<ReturnType<typeof collectReflectionSources>>;
		try {
			collected = await collectReflectionSources({
				workingDir,
				checkpoint,
				atomFeeds: settings.atomFeeds,
				githubUser: settings.githubUser,
				now,
				fetchers: options.fetchers,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[reflection] source collection failed: ${message}`);
			await appendHistory(workingDir, { at: now.toISOString(), ok: false, trigger, error: message });
			return failureResult(message);
		}

		const { items, next, stats, bootstrapped } = collected;
		const initializing =
			!hadCheckpointFile &&
			checkpoint.lastRunAt === null &&
			(bootstrapped.chats || bootstrapped.atom || bootstrapped.github);

		if (items.length === 0) {
			const updated = { ...checkpoint, ...next, lastRunAt: now.toISOString() };
			updated.lastSummary = initializing ? "initialized" : "no new signals";
			await writeCheckpoint(workingDir, updated);
			console.log(`[reflection] ${initializing ? "initialized" : "skipped"}: no new signals`);
			return {
				ok: true,
				initialized: initializing,
				skipped: !initializing,
				summary: updated.lastSummary,
				snapshotId: null,
				memoriesAdded: 0,
				notesChanged: 0,
				skillsChanged: 0,
				chats: stats.chats,
				chatMessages: 0,
				atom: 0,
				github: 0,
			};
		}

		console.log(
			`[reflection] start: chats=${stats.chats} chat_messages=${stats.chatMessages} atom=${stats.atom} github=${stats.github} trigger=${trigger}`
		);

		let proposal: ReflectionProposal;
		try {
			const llm = options.llm ?? defaultReflectionLlm(workingDir);
			proposal = await llm({
				items,
				memories: memorySummaries(workingDir),
				skills: formatSkillCatalog(listSkillCatalog(workingDir)),
				notes: formatNotesForPrompt(workingDir, Object.keys(next.chats)),
				sources: { atomFeeds: settings.atomFeeds, githubUser: settings.githubUser },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[reflection] llm failed: ${message}`);
			await appendHistory(workingDir, { at: now.toISOString(), ok: false, trigger, error: message });
			return {
				...failureResult(message),
				chats: stats.chats,
				chatMessages: stats.chatMessages,
				atom: stats.atom,
				github: stats.github,
			};
		}

		const memories = proposal.memories.slice(0, MAX_MEMORY_WRITES);
		const notes = proposal.prompt_notes.slice(0, MAX_NOTE_WRITES);
		const skills = proposal.skills.slice(0, MAX_SKILL_WRITES);
		if (
			proposal.memories.length > MAX_MEMORY_WRITES ||
			proposal.prompt_notes.length > MAX_NOTE_WRITES ||
			proposal.skills.length > MAX_SKILL_WRITES
		) {
			console.warn(
				`[reflection] truncated proposal: memories=${proposal.memories.length} notes=${proposal.prompt_notes.length} skills=${proposal.skills.length}`
			);
		}

		let snapshotId: string | null = null;
		try {
			const relativePaths = harnessPathsForProposal(notes, skills);
			if (relativePaths.length > 0) {
				snapshotId = (await createHarnessSnapshot(workingDir, trigger, relativePaths)).id;
			}

			let memoriesAdded = 0;
			for (const memory of memories) {
				const result = await saveMemory(workingDir, toSaveMemoryInput(memory, trigger, now));
				if (result.added) memoriesAdded += 1;
			}

			let notesChanged = 0;
			for (const note of notes) {
				notesChanged += (await applyNoteProposal(workingDir, note)) ? 1 : 0;
			}

			let skillsChanged = 0;
			for (const skill of skills) {
				skillsChanged += (await applySkillProposal(workingDir, skill)) ? 1 : 0;
			}

			const updated: ReflectionCheckpoint = {
				...checkpoint,
				...next,
				lastRunAt: now.toISOString(),
				lastSnapshotId: snapshotId,
				lastSummary: proposal.summary,
			};
			await writeCheckpoint(workingDir, updated);
			await appendHistory(workingDir, {
				at: now.toISOString(),
				ok: true,
				trigger,
				snapshotId,
				summary: proposal.summary,
				memoriesAdded,
				notesChanged,
				skillsChanged,
				...stats,
			});
			console.log(
				`[reflection] applied: memories_added=${memoriesAdded} notes=${notesChanged} skills=${skillsChanged} ` +
					`snapshot=${snapshotId ?? "none"} summary="${proposal.summary}"`
			);
			return {
				ok: true,
				summary: proposal.summary,
				snapshotId,
				memoriesAdded,
				notesChanged,
				skillsChanged,
				chats: stats.chats,
				chatMessages: stats.chatMessages,
				atom: stats.atom,
				github: stats.github,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[reflection] apply failed: ${message}`);
			if (snapshotId) {
				try {
					await rollbackSnapshot(workingDir, snapshotId);
				} catch (rollbackError) {
					console.error(`[reflection] snapshot rollback failed: ${rollbackError}`);
				}
			}
			await appendHistory(workingDir, {
				at: now.toISOString(),
				ok: false,
				trigger,
				snapshotId,
				error: message,
			});
			return {
				...failureResult(message),
				snapshotId,
				chats: stats.chats,
				chatMessages: stats.chatMessages,
				atom: stats.atom,
				github: stats.github,
			};
		}
	});
}

export function startReflectionScheduler(
	workingDir: string,
	options: { onSuccess?: () => void | Promise<void> } = {}
): { stop(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const run = async (reason: string) => {
		try {
			const result = await runReflection(workingDir, { trigger: reason });
			if (result.ok && !result.skipped && !result.initialized) {
				await options.onSuccess?.();
			}
			console.log(`[reflection] ${reason} done: ${formatReflectionSummary(result).replaceAll("\n", " / ")}`);
		} catch (error) {
			console.error(`[reflection] ${reason} failed:`, error);
		}
	};

	const scheduleNext = (initial: boolean) => {
		if (stopped) return;
		const settings = reflectionSettings(workingDir);
		if (!settings.enabled) {
			console.log("[reflection] scheduler disabled; retrying in 30 min");
			timer = setTimeout(() => scheduleNext(false), 30 * 60_000);
			return;
		}
		if (initial && shouldCatchUpReflection(readCheckpoint(workingDir), settings.hour)) {
			console.log(`[reflection] catch-up run scheduled (missed local hour ${settings.hour})`);
			timer = setTimeout(async () => {
				await run("catch-up");
				scheduleNext(false);
			}, 15_000);
			return;
		}
		const delay = msUntilLocalHour(settings.hour);
		console.log(`[reflection] next run in ${Math.round(delay / 60_000)} min (local hour ${settings.hour})`);
		timer = setTimeout(async () => {
			await run("nightly");
			scheduleNext(false);
		}, delay);
	};

	scheduleNext(true);
	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			console.log("[reflection] scheduler stopped");
		},
	};
}

export { rollbackSnapshot };

export function parseReflectionProposal(text: string): ReflectionProposal {
	const jsonText = extractJsonObject(text);
	const parsed = JSON.parse(jsonText) as Partial<ReflectionProposal>;
	if (!parsed || typeof parsed !== "object") throw new Error("Reflection proposal is not an object");
	return {
		summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "reflection update",
		memories: Array.isArray(parsed.memories) ? parsed.memories.map(validateMemoryProposal) : [],
		prompt_notes: Array.isArray(parsed.prompt_notes) ? parsed.prompt_notes.map(validateNoteProposal) : [],
		skills: Array.isArray(parsed.skills) ? parsed.skills.map(validateSkillProposal) : [],
	};
}

export function buildReflectionPrompt(input: ReflectionPromptInput): string {
	const memories =
		input.memories.length === 0
			? "(none)"
			: input.memories
					.map(
						(item) =>
							`- ${item.id} [${item.namespace}/${item.kind}${item.event_time ? ` ${item.event_time}` : ""}] ${item.text}`
					)
					.join("\n");

	return `You are the nightly reflection refiner for an iMessage agent.
Read new signals from chat logs, Atom/RSS feeds, and GitHub activity. Propose the smallest evidence-backed harness updates.

Configured external sources:
- atomFeeds: ${input.sources.atomFeeds.length ? input.sources.atomFeeds.join(", ") : "(none)"}
- github: ${input.sources.githubUser || "(none)"}

Return ONLY JSON with this shape:
{
  "summary": "one line",
  "memories": [{"text":"","namespace":"health/paipai","kind":"fact|event|preference|procedure","subjects":[],"event_time":"YYYY-MM-DD"|null,"importance":0.8,"confidence":0.9,"supersedes_id":"mem_..."}],
  "prompt_notes": [{"action":"create|update|delete","scope":"global|chat","chat_guid":"optional","id":"note_...","text":"optional"}],
  "skills": [{"action":"create|update|delete","name":"kebab-case","scope":"global|chat","chat_guid":"optional","description":"","instructions":""}]
}

Rules:
- Do not store a daily summary. Store only durable atomic facts.
- Facts, events, preferences → memories. Reusable multi-step workflows → skills, not procedure memories.
- Standing behavioral instructions → prompt notes. Keep notes short. Update or delete instead of duplicating.
- Atom/RSS entries and GitHub activity are first-class evidence, same as chats.
- Smallest edit. Empty arrays are fine if nothing durable appeared.
- event_time must be YYYY-MM-DD or null. Never invent a date.
- Skill names are lowercase kebab-case. Never touch file-memory. Write SKILL.md instructions only, no scripts.
- For chat-scoped notes/skills, chat_guid must be one of the chat labels in the signals.
- For update/delete, use an existing id or skill name.

Existing memories:
${memories}

Existing prompt notes:
${input.notes}

Existing skills:
${input.skills}

New signals:
${formatSourceItemsForPrompt(input.items)}
`;
}

function reflectionSettings(workingDir: string): ReflectionSettings {
	return (
		readSettings(workingDir).reflection ?? {
			enabled: true,
			hour: 3,
			atomFeeds: [],
			githubUser: "",
		}
	);
}

function defaultReflectionLlm(workingDir: string): ReflectionLlm {
	const agentDir = getAgentDir();
	const modelRuntimePromise = ModelRuntime.create({
		authPath: `${agentDir}/auth.json`,
		modelsPath: `${agentDir}/models.json`,
	});

	return async (input) => {
		const modelRuntime = await modelRuntimePromise;
		await modelRuntime.refresh();
		const settings = SettingsManager.create(workingDir, agentDir);
		const provider = settings.getDefaultProvider();
		const modelId = settings.getDefaultModel();
		if (!provider || !modelId) throw new Error("No default model configured");
		const model = modelRuntime.getModel(provider, modelId);
		if (!model) throw new Error(`Default model not found: ${provider}/${modelId}`);

		const userMessage: UserMessage = {
			role: "user",
			content: buildReflectionPrompt(input),
			timestamp: Date.now(),
		};
		console.log(`[reflection] llm start: ${provider}/${modelId}`);
		const response = await modelRuntime.complete(
			model,
			{ messages: [userMessage] },
			{
				maxTokens: 4096,
				maxRetries: 1,
				timeoutMs: REFLECTION_TIMEOUT_MS,
				signal: AbortSignal.timeout(REFLECTION_TIMEOUT_MS),
			}
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || `Model stopped with reason: ${response.stopReason}`);
		}
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("Reflection model returned no text");
		return parseReflectionProposal(text);
	};
}

function validateMemoryProposal(raw: unknown): ReflectionMemoryProposal {
	if (!raw || typeof raw !== "object") throw new Error("Invalid memory proposal");
	const item = raw as Record<string, unknown>;
	const kind = item.kind;
	if (typeof item.text !== "string" || !item.text.trim()) throw new Error("Memory text required");
	if (typeof item.namespace !== "string") throw new Error("Memory namespace required");
	if (typeof kind !== "string" || !MEMORY_KINDS.includes(kind as MemoryKind)) throw new Error("Invalid memory kind");
	if (!Array.isArray(item.subjects) || !item.subjects.every((subject) => typeof subject === "string")) {
		throw new Error("Memory subjects must be strings");
	}
	if (item.event_time !== null && typeof item.event_time !== "string") throw new Error("Invalid event_time");
	return {
		text: item.text.trim(),
		namespace: item.namespace,
		kind: kind as MemoryKind,
		subjects: item.subjects.map((subject) => String(subject)),
		event_time: item.event_time === null ? null : String(item.event_time),
		importance: typeof item.importance === "number" ? item.importance : 0.7,
		confidence: typeof item.confidence === "number" ? item.confidence : 0.8,
		...(typeof item.supersedes_id === "string" ? { supersedes_id: item.supersedes_id } : {}),
	};
}

function validateNoteProposal(raw: unknown): ReflectionNoteProposal {
	if (!raw || typeof raw !== "object") throw new Error("Invalid prompt note proposal");
	const item = raw as Record<string, unknown>;
	if (item.action !== "create" && item.action !== "update" && item.action !== "delete") {
		throw new Error("Invalid prompt note action");
	}
	if (item.scope !== "global" && item.scope !== "chat") throw new Error("Invalid prompt note scope");
	if (item.scope === "chat" && typeof item.chat_guid !== "string") throw new Error("chat_guid required for chat notes");
	if ((item.action === "update" || item.action === "delete") && typeof item.id !== "string") {
		throw new Error("prompt note id required");
	}
	if (item.action !== "delete" && (typeof item.text !== "string" || !item.text.trim())) {
		throw new Error("prompt note text required");
	}
	return {
		action: item.action,
		scope: item.scope,
		...(typeof item.chat_guid === "string" ? { chat_guid: item.chat_guid } : {}),
		...(typeof item.id === "string" ? { id: item.id } : {}),
		...(typeof item.text === "string" ? { text: item.text } : {}),
	};
}

function validateSkillProposal(raw: unknown): ReflectionSkillProposal {
	if (!raw || typeof raw !== "object") throw new Error("Invalid skill proposal");
	const item = raw as Record<string, unknown>;
	if (item.action !== "create" && item.action !== "update" && item.action !== "delete") {
		throw new Error("Invalid skill action");
	}
	if (typeof item.name !== "string") throw new Error("Skill name required");
	assertSkillName(item.name.trim());
	if (item.scope !== "global" && item.scope !== "chat") throw new Error("Invalid skill scope");
	if (item.scope === "chat" && typeof item.chat_guid !== "string")
		throw new Error("chat_guid required for chat skills");
	if (item.action !== "delete") {
		if (typeof item.description !== "string" || !item.description.trim()) throw new Error("Skill description required");
		if (typeof item.instructions !== "string" || !item.instructions.trim()) {
			throw new Error("Skill instructions required");
		}
	}
	return {
		action: item.action,
		name: item.name.trim(),
		scope: item.scope,
		...(typeof item.chat_guid === "string" ? { chat_guid: item.chat_guid } : {}),
		...(typeof item.description === "string" ? { description: item.description } : {}),
		...(typeof item.instructions === "string" ? { instructions: item.instructions } : {}),
	};
}

function toSaveMemoryInput(memory: ReflectionMemoryProposal, trigger: string, now: Date): SaveMemoryInput {
	return {
		text: memory.text,
		namespace: memory.namespace,
		kind: memory.kind,
		subjects: memory.subjects,
		event_time: memory.event_time,
		source: `${trigger} ${now.toISOString().slice(0, 10)}`,
		importance: memory.importance,
		confidence: memory.confidence,
		...(memory.supersedes_id ? { supersedes_id: memory.supersedes_id } : {}),
	};
}

async function applyNoteProposal(workingDir: string, note: ReflectionNoteProposal): Promise<boolean> {
	const chatGuid = note.scope === "chat" ? note.chat_guid : undefined;
	if (note.scope === "chat") assertKnownChat(workingDir, note.chat_guid);
	if (note.action === "delete") {
		if (!note.id) return false;
		return deleteSystemNote(workingDir, note.id, chatGuid);
	}
	await upsertSystemNote(workingDir, {
		text: note.text ?? "",
		id: note.action === "update" ? note.id : undefined,
		chatGuid,
	});
	return true;
}

async function applySkillProposal(workingDir: string, skill: ReflectionSkillProposal): Promise<boolean> {
	const chatGuid = skill.scope === "chat" ? skill.chat_guid : undefined;
	if (skill.scope === "chat") assertKnownChat(workingDir, skill.chat_guid);
	if (skill.action === "delete") {
		return deleteSkill(workingDir, skill.name, chatGuid);
	}
	const existing = listSkillCatalog(workingDir).find(
		(entry) => entry.name === skill.name && entry.scope === skill.scope && entry.chatGuid === chatGuid
	);
	if (skill.action === "update" && !existing) throw new Error(`Unknown skill: ${skill.name}`);
	if (skill.action === "create" && existing) {
		console.log(`[reflection] skill create skipped, already exists: ${skill.name}`);
		return false;
	}
	await writeSkill({
		workingDir,
		name: skill.name,
		description: skill.description ?? existing?.description ?? skill.name,
		instructions: skill.instructions ?? existing?.instructions ?? "",
		chatGuid,
	});
	return true;
}

function harnessPathsForProposal(notes: ReflectionNoteProposal[], skills: ReflectionSkillProposal[]): string[] {
	const paths: string[] = [];
	for (const note of notes) {
		paths.push(note.scope === "chat" && note.chat_guid ? join(note.chat_guid, "SYSTEM.md") : "SYSTEM.md");
	}
	for (const skill of skills) {
		paths.push(
			skill.scope === "chat" && skill.chat_guid
				? join(skill.chat_guid, "skills", skill.name)
				: join("skills", skill.name)
		);
	}
	return paths;
}

function memorySummaries(workingDir: string) {
	return activeMemoryItems(loadAllMemoryItems(workingDir))
		.sort(
			(a, b) =>
				b.importance - a.importance ||
				(b.event_time ?? "").localeCompare(a.event_time ?? "") ||
				b.created_at.localeCompare(a.created_at)
		)
		.slice(0, MAX_MEMORIES_IN_PROMPT)
		.map((item) => ({
			id: item.id,
			namespace: item.namespace,
			kind: item.kind,
			text: item.text,
			event_time: item.event_time,
		}));
}

function formatNotesForPrompt(workingDir: string, chatGuids: string[]): string {
	const notes = [
		...readSystemNotes(workingDir).map((note) => `- ${note.id} [global] ${note.text}`),
		...chatGuids.flatMap((chatGuid) =>
			readSystemNotes(workingDir, chatGuid).map((note) => `- ${note.id} [chat ${chatGuid}] ${note.text}`)
		),
	];
	return notes.length > 0 ? notes.join("\n") : "(none)";
}

function assertKnownChat(workingDir: string, chatGuid: string | undefined): void {
	if (!chatGuid || !listChatGuids(workingDir).includes(chatGuid)) {
		throw new Error(`Unknown chat_guid: ${chatGuid ?? "(missing)"}`);
	}
}

function extractJsonObject(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = (fenced?.[1] ?? text).trim();
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Reflection response did not contain JSON");
	return candidate.slice(start, end + 1);
}

async function writeCheckpoint(workingDir: string, checkpoint: ReflectionCheckpoint): Promise<void> {
	await mkdir(join(workingDir, "harness"), { recursive: true });
	await writeFile(checkpointPath(workingDir), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

async function appendHistory(workingDir: string, entry: Record<string, unknown>): Promise<void> {
	await mkdir(join(workingDir, "harness"), { recursive: true });
	await appendFile(reflectionHistoryPath(workingDir), `${JSON.stringify(entry)}\n`, "utf8");
}

async function withReflectionLock<T>(workingDir: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = join(workingDir, "harness", ".run-lock");
	await mkdir(join(workingDir, "harness"), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error("Timed out waiting for reflection lock");
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	try {
		return await operation();
	} finally {
		await rmdir(lockPath).catch(() => {});
	}
}

function failureResult(message: string): ReflectionResult {
	return {
		ok: false,
		summary: message,
		snapshotId: null,
		memoriesAdded: 0,
		notesChanged: 0,
		skillsChanged: 0,
		chats: 0,
		chatMessages: 0,
		atom: 0,
		github: 0,
		error: message,
	};
}

function readAtomCheckpoint(raw: unknown): Record<string, { seenGuids: string[] }> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const atom: Record<string, { seenGuids: string[] }> = {};
	for (const [feedUrl, state] of Object.entries(raw as Record<string, unknown>)) {
		if (!feedUrl.trim() || !state || typeof state !== "object") continue;
		const seenGuids = (state as { seenGuids?: unknown }).seenGuids;
		atom[feedUrl] = {
			seenGuids: Array.isArray(seenGuids) ? seenGuids.filter((id): id is string => typeof id === "string") : [],
		};
	}
	return atom;
}
