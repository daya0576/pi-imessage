/**
 * Agent module — text-in / text-out AI processor per iMessage chat.
 *
 * Each chat gets a lazily-created AgentSession with persistent context
 * (context.jsonl per chat directory).
 *
 * Concurrency: callers must serialize messages for the same chat externally
 * (imessage.ts does this via per-chat promise chains). Different chats run
 * concurrently.
 *
 * Model: uses ~/.pi/agent/ defaults (via createAgentSession).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, type Message, type TextContent, Type } from "@earendil-works/pi-ai";
import type { CompactionResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	defineTool,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { formatSkillCatalog, listSkillCatalog } from "./harness.js";
import { listMemoryNamespaces, loadMemoryNamespaces, readCoreMemory, saveMemory, searchMemory } from "./memory.js";
import type { AgentReply, IncomingMessage } from "./types.js";

// ── Config & Types ────────────────────────────────────────────────────────────

/**
 * Abort a prompt only after this much continuous inactivity. Any agent event —
 * including streamed model output and tool start/end events — refreshes it.
 */
export const AGENT_IDLE_TIMEOUT_MS = Number.parseInt(process.env.AGENT_IDLE_TIMEOUT_MS || "120000", 10);

/** Absolute safety ceiling that activity cannot extend. */
export const AGENT_MAX_PROMPT_DURATION_MS = Number.parseInt(process.env.AGENT_MAX_PROMPT_DURATION_MS || "1800000", 10);
export const AGENT_COMPACT_TIMEOUT_MS = Number.parseInt(process.env.AGENT_COMPACT_TIMEOUT_MS || "60000", 10);
export const AUTO_COMPACT_CONTEXT_RATIO = Number.parseFloat(process.env.AGENT_AUTO_COMPACT_RATIO || "0.7");
export const AUTO_COMPACT_FALLBACK_TOKENS = 100_000;

/**
 * Compact relative to the selected model's context window instead of using a
 * fixed low threshold. AGENT_AUTO_COMPACT_TOKENS remains an explicit override.
 */
export function getAutoCompactTokenThreshold(
	contextWindow?: number,
	explicitTokens = process.env.AGENT_AUTO_COMPACT_TOKENS || ""
): number {
	const explicit = Number.parseInt(explicitTokens, 10);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return AUTO_COMPACT_FALLBACK_TOKENS;
	}
	const ratio =
		Number.isFinite(AUTO_COMPACT_CONTEXT_RATIO) && AUTO_COMPACT_CONTEXT_RATIO > 0 && AUTO_COMPACT_CONTEXT_RATIO < 1
			? AUTO_COMPACT_CONTEXT_RATIO
			: 0.7;
	return Math.floor(contextWindow * ratio);
}

const FAST_OPENAI_CODEX_MODELS = /^(?:gpt-5\.6-(?:sol|terra|luna)|gpt-6-astra)$/;

/** Enable OpenAI priority processing without enabling user-discovered extensions. */
export function openAiCodexFastExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex" || !FAST_OPENAI_CODEX_MODELS.test(ctx.model.id)) {
			return;
		}
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
			return;
		}
		return { ...event.payload, service_tier: "priority" };
	});
}

export interface AgentManagerConfig {
	workingDir: string;
}

interface ChatSession {
	session: AgentSession;
	chatGuid: string;
	sessionMapKey: string;
	sessionDir: string;
	/** Promise chain serializing prompts for this chat or isolated task session. */
	chain: Promise<void>;
}

export interface ProcessMessageOptions {
	streamingBehavior?: "steer" | "followUp";
	/** Separate model context from the destination chat while still delivering replies there. */
	sessionKey?: string;
	/** Remove the isolated session after all prompts queued on it have completed. */
	ephemeral?: boolean;
}

const SESSION_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function resolveSessionStorage(
	workingDir: string,
	chatGuid: string,
	options?: Pick<ProcessMessageOptions, "sessionKey" | "ephemeral">
): { mapKey: string; sessionDir: string; isolated: boolean } {
	if (options?.ephemeral && !options.sessionKey) {
		throw new Error("ephemeral sessions require sessionKey");
	}
	if (!options?.sessionKey) {
		return {
			mapKey: chatGuid,
			sessionDir: join(workingDir, sanitizeChatGuid(chatGuid)),
			isolated: false,
		};
	}
	if (!SESSION_KEY_PATTERN.test(options.sessionKey)) {
		throw new Error("sessionKey must be 1-128 characters using only letters, numbers, '.', '_' or '-'");
	}
	const safeChatGuid = sanitizeChatGuid(chatGuid);
	return {
		mapKey: `task:${safeChatGuid}:${options.sessionKey}`,
		sessionDir: join(workingDir, ".task-sessions", safeChatGuid, options.sessionKey),
		isolated: true,
	};
}

/**
 * Stop model work without injecting a synthetic user message into the transcript.
 *
 * AgentSession.steer("stop") is not an abort API: it queues a literal user
 * message. If the current operation fails before consuming that queue (for
 * example, compaction fails), the stale "stop" can be delivered with a later
 * real chat message and misattributed to that sender.
 */
export async function clearAndAbortSession(session: Pick<AgentSession, "abort" | "clearQueue">): Promise<void> {
	session.clearQueue();
	await session.abort();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Race an async operation against a wall-clock timeout.
 *
 * If `operation()` settles first, its result (or rejection) is passed through
 * and the timer is cleared. If the timeout fires first, `onTimeout()` is invoked
 * (best-effort — e.g. to abort the underlying request) and the returned promise
 * rejects with a timeout Error. A failure inside `onTimeout()` never masks the
 * timeout rejection.
 *
 * Note: this does not cancel `operation()` itself — cancellation must happen via
 * `onTimeout` (the SDK exposes `AgentSession.abort()`). The timeout rejects
 * immediately without waiting for cancellation, because a stuck abort must not
 * keep the caller blocked.
 */
export async function runWithTimeout<T>(
	operation: () => Promise<T>,
	onTimeout: () => Promise<void> | void,
	timeoutMs: number
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			try {
				void Promise.resolve(onTimeout()).catch(() => {});
			} catch {
				// A cleanup failure must never suppress the timeout.
			}
			reject(new Error(`operation timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([operation(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export type ActivityTimeoutKind = "idle" | "max_duration";

/**
 * Race an operation against a sliding inactivity timeout and a separate hard
 * duration ceiling. Calling `markActivity()` refreshes only the idle timer.
 */
export async function runWithActivityTimeout<T>(
	operation: (markActivity: () => void) => Promise<T>,
	onTimeout: (kind: ActivityTimeoutKind) => Promise<void> | void,
	idleTimeoutMs: number,
	maxDurationMs: number
): Promise<T> {
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let maxTimer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	let rejectTimeout: (reason: Error) => void = () => {};

	const clearTimers = () => {
		if (idleTimer) clearTimeout(idleTimer);
		if (maxTimer) clearTimeout(maxTimer);
	};
	const fireTimeout = (kind: ActivityTimeoutKind, timeoutMs: number) => {
		if (settled) return;
		settled = true;
		clearTimers();
		try {
			void Promise.resolve(onTimeout(kind)).catch(() => {});
		} catch {
			// A cleanup failure must never suppress the timeout.
		}
		const message =
			kind === "idle"
				? `operation idle timed out after ${timeoutMs}ms`
				: `operation exceeded maximum duration of ${timeoutMs}ms`;
		rejectTimeout(new Error(message));
	};
	const markActivity = () => {
		if (settled) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => fireTimeout("idle", idleTimeoutMs), idleTimeoutMs);
	};

	const timeout = new Promise<never>((_resolve, reject) => {
		rejectTimeout = reject;
		markActivity();
		if (maxDurationMs > 0) {
			maxTimer = setTimeout(() => fireTimeout("max_duration", maxDurationMs), maxDurationMs);
		}
	});
	const operationPromise = Promise.resolve().then(() => operation(markActivity));
	try {
		return await Promise.race([operationPromise, timeout]);
	} finally {
		settled = true;
		clearTimers();
	}
}

/**
 * Format a prompt with sender/chat context prefix.
 *
 * Examples:
 *   [DM from +1234567890] hey
 *   [SMS from +1234567890] hey
 *   [Group 'Family' from alice@example.com] hey
 */
function formatPromptText(msg: IncomingMessage): string {
	const text = msg.text ?? "";
	let prefix: string;
	if (msg.messageType === "group") {
		const name = msg.groupName || "unnamed";
		prefix = `[Group '${name}' from ${msg.sender}]`;
	} else if (msg.messageType === "sms") {
		prefix = `[SMS from ${msg.sender}]`;
	} else {
		prefix = `[DM from ${msg.sender}]`;
	}

	if (msg.replyToText) {
		return `${prefix} [replying to: "${msg.replyToText}"] ${text}`;
	}

	return `${prefix} ${text}`;
}

/** Replace characters that are invalid in directory names. */
function sanitizeChatGuid(chatGuid: string): string {
	return chatGuid.replace(/[^a-zA-Z0-9_\-;+.@]/g, "_");
}

/** Read a file's trimmed content, or return undefined if missing/empty. */
function readFileIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const content = readFileSync(path, "utf-8").trim();
		return content || undefined;
	} catch (error) {
		console.warn(`[agent] failed to read ${path}: ${error}`);
		return undefined;
	}
}

function getCustomPrompt(workingDir: string, chatDir?: string): string {
	const parts: string[] = [];
	const global = readFileIfExists(join(workingDir, "SYSTEM.md"));
	if (global) parts.push(global);
	if (chatDir) {
		const chat = readFileIfExists(join(chatDir, "SYSTEM.md"));
		if (chat) parts.push(chat);
	}
	return parts.join("\n\n");
}

/** Base voice / personality locked in code (not editable via reflection notes). */
export const BASE_PERSONALITY = `You are the user's best friend communicating via iMessage. Be concise. No emojis.

## Context
- Plain text only. Do not use Markdown formatting, double asterisks (**like this**), or [markdown](links).
- Reply in the same language the user is writing in.`;

export function buildSystemPrompt(workingDir: string, chatGuid?: string, chatDir?: string): string {
	const coreMemory = readCoreMemory(workingDir);
	const namespaces = listMemoryNamespaces(workingDir)
		.map((item) => `${item.namespace} (${item.active} active)`)
		.join(", ");
	const customPrompt = getCustomPrompt(workingDir, chatDir);
	const skills = formatSkillCatalog(listSkillCatalog(workingDir, chatGuid));

	return `${BASE_PERSONALITY}

## Environment
You are running directly on the host machine.
- Bash working directory: ${workingDir}
- Be careful with system modifications;

## Workspace Layout
${workingDir}/
├── settings.json                # Bot configuration (see below)
├── MEMORY.md                    # Legacy memory archive; do not write new entries
├── SYSTEM.md                    # Env log + Prompt Notes (notes are reflection-managed)
├── harness/                     # Reflection checkpoint, snapshots, history
├── skills/file-memory/          # Structured memory store and CLI
└── <chatId>/                    # Each iMessage chat gets a directory
    ├── MEMORY.md                # Legacy chat memory archive
    ├── context.jsonl            # LLM context (session persistence)
    ├── log.jsonl                # Message history
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Chat-specific tools

## Memory
Structured memory is the only active read/write memory. Legacy MEMORY.md files are read-only archives.

Read:
- Use the typed load_memory tool when prior context may help. You choose one or more relevant namespaces from meaning and conversation context, not fixed keywords.
- load_memory returns every active record in each selected namespace. A namespace is injected only once per session; later calls return only newly added records.
- Available namespaces: ${namespaces || "(none yet)"}
- Use search_memory only to find a specific old record, especially before a correction. Do not use it as automatic per-record retrieval.
- Treat retrieved memory as context, not as a substitute for the current message or verified facts.

Write:
- When you learn something important and durable, call save_memory with concise atomic text, namespace, kind, subjects, factual event date when known, and a specific source.
- Do not store every message, guesses, short-lived states, secrets, or duplicate facts.
- For corrections, find the old ID and set supersedes_id. Never silently overwrite history.
- Do not edit JSONL or legacy MEMORY.md directly.

### Core Memory
${coreMemory}

## System Configuration Log
Maintain ${workingDir}/SYSTEM.md to log all environment modifications:
- Installed packages (npm install, pip install, brew install, etc.)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment.
Do not edit the \`# Prompt Notes\` section or \`<!-- id: note_... -->\` blocks; nightly reflection owns those.

## Messaging and Reminder API
A local HTTP server runs at http://localhost:7750 with endpoints for sending messages and scheduling reminders:

### POST /send — send a message or local file attachment directly
\`\`\`bash
curl -X POST http://localhost:7750/send \\
  -H "Content-Type: application/json" \\
  -d '{"chatGuid":"<chatGuid>","text":"hello"}'

curl -X POST http://localhost:7750/send \\
  -H "Content-Type: application/json" \\
  -d '{"chatGuid":"<chatGuid>","filePath":"/path/to/image.png"}'
\`\`\`

### POST /prompt — send a prompt to the agent, send the agent's reply to the chat
The prompt is processed by the agent (you). After processing completes, only the final
assistant text replies are sent to the chat. Tool execution output is not sent.
\`\`\`bash
curl -X POST http://localhost:7750/prompt \\
  -H "Content-Type: application/json" \\
  -d '{"chatGuid":"<chatGuid>","prompt":"generate a daily summary"}'
\`\`\`
If the agent is already processing a message for this chat, the prompt is queued (followUp)
and will run after the current processing finishes. Heavy automated tasks should provide a safe
\`sessionKey\` and \`ephemeral:true\` so their tool and image context is isolated from the destination chat
and removed after completion; replies are still delivered to \`chatGuid\`.

### POST /reminders — schedule a persistent one-time reminder
Use this instead of creating a one-off script or crontab entry. \`scheduledAt\` must be
ISO 8601 with an explicit timezone. The reminder survives service restarts, catches up
after downtime, retries transient send failures, and supports an optional idempotency key.
\`\`\`bash
curl -X POST http://localhost:7750/reminders \\
  -H "Content-Type: application/json" \\
  -d '{"chatGuid":"<chatGuid>","text":"check the oven","scheduledAt":"2026-08-08T21:30:00+08:00","idempotencyKey":"check-oven-2026-08-08"}'

curl 'http://localhost:7750/reminders?status=pending'
curl -X DELETE http://localhost:7750/reminders/<reminderId>
\`\`\`

Use system crontab (\`crontab -e\`) only for recurring messages or tasks.
Example recurring crontab entries:
\`\`\`
# Send a static message every morning at 9:00
0 9 * * * curl -s -X POST http://localhost:7750/send -H "Content-Type: application/json" -d '{"chatGuid":"iMessage;-;+1234567890","text":"good morning"}'
# Generate and send a daily summary every evening at 21:00
0 21 * * * curl -s -X POST http://localhost:7750/prompt -H "Content-Type: application/json" -d '{"chatGuid":"iMessage;-;+1234567890","prompt":"generate a daily summary and send it"}'
\`\`\`

## Skills (Custom CLI Tools)
Available skills (read SKILL.md for details, then run the CLI if present):
${skills}

You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workingDir}/skills/<name>/\` (global) or \`<chatDir>/skills/<name>/\` (chat-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: What this skill does
---
Usage instructions and details here.
\`\`\`${customPrompt ? `\n\n${customPrompt}` : ""}`;
}

/** Extract concatenated text from a Message, ignoring non-text content parts. */
function extractMessageText(message: Message): string | null {
	if (typeof message.content === "string") return message.content;

	const texts = message.content
		.filter((part): part is TextContent => part.type === "text" && "text" in part)
		.map((part) => part.text);
	const joined = texts.join("\n").trim();
	return joined || null;
}

/** Extract human-readable text from a tool result (string or content-array). */
function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;

	if (result && typeof result === "object" && "content" in result) {
		const content = (result as { content: unknown }).content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const part of content) {
				if (part && typeof part === "object" && part.type === "text" && "text" in part) {
					parts.push(part.text as string);
				}
			}
			const joined = parts.join("\n").trim();
			if (joined) return joined;
		}
	}
	return JSON.stringify(result);
}

/** Pick a human-readable label for a tool invocation. */
function extractToolLabel(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "bash" && typeof args.command === "string") return args.command;
	if (toolName === "load_memory" && Array.isArray(args.namespaces)) return `memory: ${args.namespaces.join(", ")}`;
	if (typeof args.path === "string") return `${toolName}: ${args.path}`;
	if (typeof args.label === "string") return args.label;
	return toolName;
}

function createMemoryExtension(workingDir: string, loadedIds: Set<string>) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool(
			defineTool({
				name: "load_memory",
				label: "Load Memory",
				description:
					"Load all active records from one or more semantically relevant namespaces. Select namespaces yourself from the conversation. Repeated calls return only records not already loaded in this session.",
				parameters: Type.Object({
					namespaces: Type.Array(Type.String(), { minItems: 1 }),
				}),
				async execute(_toolCallId, params) {
					const records = loadMemoryNamespaces(workingDir, params.namespaces);
					const delta = records.filter((item) => !loadedIds.has(item.id));
					for (const item of delta) loadedIds.add(item.id);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									namespaces: params.namespaces,
									records: delta,
									already_loaded: records.length - delta.length,
								}),
							},
						],
						details: { namespaces: params.namespaces, loaded: delta.length },
					};
				},
			})
		);

		pi.registerTool(
			defineTool({
				name: "search_memory",
				label: "Search Memory",
				description: "Find a specific active memory record, primarily to locate its ID before saving a correction.",
				parameters: Type.Object({
					query: Type.String(),
					namespaces: Type.Optional(Type.Array(Type.String())),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
				}),
				async execute(_toolCallId, params) {
					const records = searchMemory(workingDir, params.query, {
						namespaces: params.namespaces,
						limit: params.limit,
					});
					return {
						content: [{ type: "text", text: JSON.stringify({ records }) }],
						details: { matches: records.length },
					};
				},
			})
		);

		pi.registerTool(
			defineTool({
				name: "save_memory",
				label: "Save Memory",
				description: "Validate and append one durable atomic record to the structured memory source of truth.",
				parameters: Type.Object({
					text: Type.String(),
					namespace: Type.String(),
					kind: Type.Union([
						Type.Literal("fact"),
						Type.Literal("event"),
						Type.Literal("preference"),
						Type.Literal("procedure"),
					]),
					subjects: Type.Array(Type.String()),
					event_time: Type.Union([Type.String(), Type.Null()]),
					source: Type.String(),
					importance: Type.Number({ minimum: 0, maximum: 1 }),
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
					supersedes_id: Type.Optional(Type.String()),
				}),
				async execute(_toolCallId, params) {
					const result = await saveMemory(workingDir, params);
					loadedIds.add(result.item.id);
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: { added: result.added, id: result.item.id },
					};
				},
			})
		);
	};
}

// ── Agent Manager ─────────────────────────────────────────────────────────────

export async function createAgentManager(config: AgentManagerConfig) {
	const { workingDir } = config;
	const sessionMap = new Map<string, ChatSession>();
	let activePrompts = 0;
	let lastAgentActivityAt: number | null = null;
	const agentDir = getAgentDir();

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});

	/** Create a new AgentSession for a chat or isolated task, persisted to its own context.jsonl. */
	async function createSession(sessionMapKey: string, chatGuid: string, sessionDir: string): Promise<ChatSession> {
		mkdirSync(sessionDir, { recursive: true });
		const sessionManager = SessionManager.open(join(sessionDir, "context.jsonl"), sessionDir);
		const loadedMemoryIds = new Set<string>();

		// Force SSE for pi-imessage. Large Codex contexts frequently exceed the
		// WebSocket frame limit or leave an auto-selected socket half-open.
		const settingsManager = SettingsManager.create(workingDir, agentDir);
		settingsManager.applyOverrides({ transport: "sse" });

		// Per-session resource loader so the system prompt can reference its isolated directory.
		const resourceLoader = new DefaultResourceLoader({
			cwd: workingDir,
			agentDir,
			settingsManager,
			systemPrompt: buildSystemPrompt(workingDir, sanitizeChatGuid(chatGuid), sessionDir),
			// Keep extension discovery disabled, but install this one controlled
			// inline hook so Codex 5.6 fast mode still applies to iMessage.
			extensionFactories: [
				{ name: "openai-codex-fast", factory: openAiCodexFastExtension },
				{ name: "structured-memory", factory: createMemoryExtension(workingDir, loadedMemoryIds) },
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const extensionErrors = resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			throw new Error(`Failed to enable Codex fast mode: ${extensionErrors.map((item) => item.error).join("; ")}`);
		}

		const { session } = await createAgentSession({
			cwd: workingDir,
			agentDir,
			modelRuntime,
			sessionManager,
			settingsManager,
			resourceLoader,
		});

		const modelLabel = session.model ? `${session.model.provider}/${session.model.id}` : "default";
		console.log(
			`[agent] session created: ${chatGuid} session=${sessionMapKey} model=${modelLabel} transport=sse sol_fast=priority`
		);

		const entry: ChatSession = { session, chatGuid, sessionMapKey, sessionDir, chain: Promise.resolve() };
		sessionMap.set(sessionMapKey, entry);
		return entry;
	}

	/**
	 * Send a user message through the agent and deliver replies via the handler.
	 *
	 * Calls are serialized per chat via a promise chain on the session entry,
	 * so concurrent callers (queue + web) safely queue instead of colliding.
	 */
	async function processMessage(
		msg: IncomingMessage,
		handler: (reply: AgentReply) => Promise<void>,
		options?: ProcessMessageOptions
	): Promise<void> {
		const storage = resolveSessionStorage(workingDir, msg.chatGuid, options);
		const entry =
			sessionMap.get(storage.mapKey) ?? (await createSession(storage.mapKey, msg.chatGuid, storage.sessionDir));
		const queuedAt = Date.now();
		const run = () => runPrompt(entry, msg, handler, queuedAt, options);
		const runPromise = entry.chain.then(run, run);
		entry.chain = runPromise;
		try {
			await runPromise;
		} finally {
			// Only the last prompt queued on an ephemeral session performs cleanup.
			if (options?.ephemeral && entry.chain === runPromise && sessionMap.get(storage.mapKey) === entry) {
				sessionMap.delete(storage.mapKey);
				try {
					rmSync(storage.sessionDir, { recursive: true, force: true });
					console.log(`[agent] ephemeral session removed: ${storage.mapKey}`);
				} catch (error) {
					console.error(`[agent] ephemeral session cleanup failed: ${storage.mapKey}`, error);
				}
			}
		}
	}

	async function runPrompt(
		entry: ChatSession,
		msg: IncomingMessage,
		handler: (reply: AgentReply) => Promise<void>,
		queuedAt: number,
		options?: ProcessMessageOptions
	): Promise<void> {
		const { session, chatGuid, sessionMapKey } = entry;

		const promptText = formatPromptText(msg);

		const images = msg.images.length > 0 ? msg.images : undefined;
		const modelLabel = session.model ? `${session.model.provider}/${session.model.id}` : "default";
		const promptStart = Date.now();
		const queueWaitMs = promptStart - queuedAt;
		console.log(
			`[agent] prompt start: ${chatGuid} model=${modelLabel} queue_ms=${queueWaitMs} ` +
				`chars=${promptText.length} images=${msg.images.length} "${promptText.substring(0, 60)}"`
		);
		activePrompts += 1;
		lastAgentActivityAt = Date.now();

		// Subscribe for this prompt's lifetime, routing events through handler
		let replyChain = Promise.resolve();
		let firstAssistantStartMs: number | null = null;
		let assistantDurationMs: number | null = null;
		const pendingTools = new Map<string, { toolName: string; startTime: number; hidden: boolean }>();
		let markActivity = () => {};
		const queueReply = (reply: AgentReply) => {
			replyChain = replyChain
				.then(() => handler(reply))
				.catch((error) => {
					console.error(`[agent] reply handler error: ${chatGuid}`, error);
				});
		};

		const unsubscribe = session.subscribe((event) => {
			// Every session event proves the run is alive. This includes streamed
			// message updates as well as tool lifecycle events.
			lastAgentActivityAt = Date.now();
			markActivity();
			if (event.type === "message_start" && event.message.role === "assistant") {
				firstAssistantStartMs ??= Date.now() - promptStart;
				console.log(`[agent] message start: ${chatGuid} role=assistant first_token_ms=${Date.now() - promptStart}`);
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				const text = extractMessageText(event.message);
				assistantDurationMs = firstAssistantStartMs === null ? null : Date.now() - promptStart - firstAssistantStartMs;
				console.log(
					`[agent] message end: ${chatGuid} stopReason=${assistantMsg.stopReason}` +
						`${assistantMsg.errorMessage ? ` error="${assistantMsg.errorMessage}"` : ""}` +
						` first_token_ms=${firstAssistantStartMs ?? "n/a"} generation_ms=${assistantDurationMs ?? "n/a"}` +
						` chars=${text?.length ?? 0} text="${(text ?? "(empty)").substring(0, 60)}"`
				);
				if (text) {
					queueReply({ kind: "assistant", text });
				}
			} else if (event.type === "tool_execution_start") {
				const toolArgs = event.args as Record<string, unknown>;
				const label = extractToolLabel(event.toolName, toolArgs);
				const hidden =
					["load_memory", "search_memory", "save_memory"].includes(event.toolName) ||
					(event.toolName === "bash" && label.includes("skills/file-memory/memory_cli.py"));
				pendingTools.set(event.toolCallId, { toolName: event.toolName, startTime: Date.now(), hidden });
				console.log(`[agent] tool start: ${chatGuid} → ${label}`);
				if (!hidden) queueReply({ kind: "tool_start", label });
			} else if (event.type === "tool_execution_end") {
				const resultText = extractToolResultText(event.result);
				const pending = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);
				const duration = ((pending ? Date.now() - pending.startTime : 0) / 1000).toFixed(1);
				const symbol = event.isError ? "✗" : "✓";
				console.log(
					`[agent] tool end: ${chatGuid} ${symbol} ${event.toolName} (${duration}s)` +
						` result="${resultText.substring(0, 60)}"`
				);
				if (!pending?.hidden) {
					queueReply({ kind: "tool_end", toolName: event.toolName, symbol, duration, result: resultText });
				}
			}
		});

		try {
			await runWithActivityTimeout(
				async (activity) => {
					markActivity = activity;
					activity();
					await session.prompt(promptText, { images, streamingBehavior: options?.streamingBehavior });
				},
				(kind) => {
					const timeoutMs = kind === "idle" ? AGENT_IDLE_TIMEOUT_MS : AGENT_MAX_PROMPT_DURATION_MS;
					const label = kind === "idle" ? "idle timeout" : "maximum duration exceeded";
					console.error(
						`[agent] prompt ${label}: ${chatGuid} after ${timeoutMs}ms — detaching session and aborting in background`
					);
					if (sessionMap.get(sessionMapKey) === entry) sessionMap.delete(sessionMapKey);
					void clearAndAbortSession(session).catch((error) => {
						console.error(`[agent] background abort failed: ${chatGuid}`, error);
					});
				},
				AGENT_IDLE_TIMEOUT_MS,
				AGENT_MAX_PROMPT_DURATION_MS
			);
			const sessionEnd = Date.now();
			await replyChain;
			const replyEnd = Date.now();
			console.log(
				`[agent] prompt end: ${chatGuid} total_ms=${replyEnd - promptStart} session_ms=${sessionEnd - promptStart} ` +
					`handler_ms=${replyEnd - sessionEnd} first_token_ms=${firstAssistantStartMs ?? "n/a"} ` +
					`generation_ms=${assistantDurationMs ?? "n/a"}`
			);

			// Never make the current user wait for preventive compaction. Reply
			// first, mark the prompt complete, then compact before the next queued
			// prompt only when the model-relative threshold has been crossed.
			const contextUsage = session.getContextUsage();
			const threshold = getAutoCompactTokenThreshold(session.model?.contextWindow);
			if (!options?.ephemeral && typeof contextUsage?.tokens === "number" && contextUsage.tokens >= threshold) {
				console.log(
					`[agent] post-reply compact start: ${chatGuid} tokens=${contextUsage.tokens} threshold=${threshold} ` +
						`context_window=${session.model?.contextWindow ?? "unknown"}`
				);
				try {
					const result = await runWithTimeout(
						() => session.compact(),
						() => {
							console.error(`[agent] post-reply compact timeout: ${chatGuid} after ${AGENT_COMPACT_TIMEOUT_MS}ms`);
							if (sessionMap.get(sessionMapKey) === entry) sessionMap.delete(sessionMapKey);
							void clearAndAbortSession(session).catch(() => {});
						},
						AGENT_COMPACT_TIMEOUT_MS
					);
					console.log(`[agent] post-reply compact end: ${chatGuid} tokens_before=${result.tokensBefore}`);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					console.log(`[agent] post-reply compact skipped: ${chatGuid} ${message}`);
				}
			}
		} catch (error) {
			// Never inject a steering message here. steer("stop") queues literal
			// user text, which can survive a failed compaction and contaminate the
			// next prompt. Abort and clear pending queues instead.
			void clearAndAbortSession(session).catch(() => {});
			throw error;
		} finally {
			unsubscribe();
			activePrompts = Math.max(0, activePrompts - 1);
		}
	}

	/** Abort the in-progress agent run for a chat. No-op if no session or not running. */
	async function stop(chatGuid: string): Promise<void> {
		const entry = sessionMap.get(chatGuid);
		if (!entry) {
			console.log(`[agent] stop: no active session for ${chatGuid}`);
			return;
		}
		await clearAndAbortSession(entry.session);
		console.log(`[agent] stop aborted: ${chatGuid}`);
	}

	/** Compact the session context, reducing token usage while preserving a summary. */
	async function compact(chatGuid: string, customInstructions?: string): Promise<string> {
		const storage = resolveSessionStorage(workingDir, chatGuid);
		const entry = sessionMap.get(chatGuid) ?? (await createSession(storage.mapKey, chatGuid, storage.sessionDir));
		const { session } = entry;
		let result: CompactionResult;
		try {
			result = await session.compact(customInstructions);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("Already compacted")) {
				console.log(`[agent] compact skipped (already compacted): ${chatGuid}`);
				return "Already compacted — nothing to do";
			}
			throw error;
		}
		const beforeTokens = formatTokenCount(result.tokensBefore);
		const summary = `\u2713 Compacted ${beforeTokens} tokens`;
		console.log(`[agent] compact: ${chatGuid} ${summary}`);
		return summary;
	}

	/** Start a new session for a chat: evict in-memory session, delete context, recreate fresh. */
	async function newSession(chatGuid: string): Promise<void> {
		sessionMap.delete(chatGuid);
		const chatDir = join(workingDir, sanitizeChatGuid(chatGuid));
		const contextFile = join(chatDir, "context.jsonl");
		if (existsSync(contextFile)) {
			unlinkSync(contextFile);
		}
		const storage = resolveSessionStorage(workingDir, chatGuid);
		await createSession(storage.mapKey, chatGuid, storage.sessionDir);
		console.log(`[agent] new session: ${chatGuid}`);
	}

	/**
	 * Get a formatted status string for an active chat session.
	 *
	 * Format (two lines):
	 *   💬 3 msgs - ↑7.2k ↓505 1.1%/128k
	 *   🤖 github-copilot/gpt-5-mini • 💭 minimal
	 */
	async function getSessionStatus(chatGuid: string): Promise<string> {
		const entry = sessionMap.get(chatGuid);
		if (!entry) return "no active session";
		const { session } = entry;
		const stats = session.getSessionStats();
		const contextUsage = session.getContextUsage();
		const model = session.model;
		const thinkingLevel = session.thinkingLevel;

		// Line 1: message count + token counts + context usage
		const line1Parts: string[] = [];
		line1Parts.push(`💬 ${stats.userMessages} msgs`);
		line1Parts.push(`↑${formatTokenCount(stats.tokens.input)}`);
		line1Parts.push(`↓${formatTokenCount(stats.tokens.output)}`);
		if (contextUsage) {
			const percent = contextUsage.percent !== null ? `${contextUsage.percent.toFixed(1)}%` : "?%";
			const window = formatTokenCount(contextUsage.contextWindow);
			line1Parts.push(`${percent}/${window}`);
		}
		const line1 = `${line1Parts[0]} - ${line1Parts.slice(1).join(" ")}`;

		// Line 2: provider/model • thinking level
		const modelLabel = model ? `${model.provider}/${model.id}` : "default";
		const line2 = `🤖 ${modelLabel} • 💭 ${thinkingLevel ?? "off"}`;

		return `${line1}\n${line2}`;
	}

	/**
	 * Switch the requesting session to the current default model from settings.
	 *
	 * Mirrors pi TUI's /model command flow:
	 *   1. modelRuntime.refresh() — reload models from disk
	 *   2. Resolve model from settings (TUI uses manual selection instead)
	 *   3. session.setModel() — updates agent + context.jsonl + settings.json
	 *
	 * Reference: pi-coding-agent/dist/modes/interactive/interactive-mode.js
	 *   handleModelCommand() → getModelCandidates() → session.setModel()
	 */
	async function reload(chatGuid: string): Promise<void> {
		await modelRuntime.refresh();
		const settings = SettingsManager.create(workingDir, agentDir);
		const provider = settings.getDefaultProvider();
		const modelId = settings.getDefaultModel();
		const newModel = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;

		if (!newModel) {
			console.log("[agent] reload: no default model in settings");
			return;
		}

		const entry = sessionMap.get(chatGuid);
		if (!entry) {
			console.log(`[agent] reload: no active session for ${chatGuid}`);
			return;
		}
		const thinkingLevel = settings.getDefaultThinkingLevel();
		await entry.session.setModel(newModel);
		if (thinkingLevel) {
			entry.session.setThinkingLevel(thinkingLevel);
		}
		console.log(
			`[agent] reloaded: ${chatGuid} switched to ${provider}/${modelId} thinkingLevel=${thinkingLevel ?? "unchanged"}`
		);
	}

	function getRuntimeStatus() {
		return {
			activePrompts,
			sessions: sessionMap.size,
			lastAgentActivityAt: lastAgentActivityAt === null ? null : new Date(lastAgentActivityAt).toISOString(),
		};
	}

	/** Drop in-memory sessions so the next prompt reloads SYSTEM.md notes and skills. */
	function invalidateSessions(): void {
		const count = sessionMap.size;
		sessionMap.clear();
		console.log(`[agent] invalidated ${count} in-memory session(s) to reload system prompt`);
	}

	return {
		processMessage,
		newSession,
		getSessionStatus,
		getRuntimeStatus,
		reload,
		stop,
		compact,
		invalidateSessions,
	};
}

/** Format a token count as a compact string: 0, 1.2k, 5.9k, 12k, 1.8M, etc. */
function formatTokenCount(tokens: number): string {
	if (tokens === 0) return "0";
	if (tokens < 1_000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

type CreatedAgentManager = Awaited<ReturnType<typeof createAgentManager>>;
export type AgentManager = Pick<
	CreatedAgentManager,
	"processMessage" | "newSession" | "getSessionStatus" | "reload" | "stop" | "compact" | "invalidateSessions"
> &
	Partial<Pick<CreatedAgentManager, "getRuntimeStatus">>;
