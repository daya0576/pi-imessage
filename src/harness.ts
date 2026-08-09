/**
 * Harness state for nightly reflection: SYSTEM.md prompt notes, skill catalog, snapshots.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const RESERVED_SKILL_NAMES = new Set(["file-memory"]);
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NOTE_BLOCK = /<!-- id: (note_[a-f0-9]+) -->\n([\s\S]*?)\n<!-- \/id: \1 -->/g;

export interface SkillCatalogEntry {
	name: string;
	description: string;
	scope: "global" | "chat";
	chatGuid?: string;
	relativeDir: string;
	instructions: string;
}

export interface SystemNote {
	id: string;
	text: string;
	scope: "global" | "chat";
	chatGuid?: string;
}

export interface SnapshotFileRecord {
	action: "backup" | "created";
	relativePath: string;
}

export interface SnapshotManifest {
	id: string;
	created_at: string;
	trigger: string;
	files: SnapshotFileRecord[];
}

export function harnessDir(workingDir: string): string {
	return join(workingDir, "harness");
}

export function snapshotsDir(workingDir: string): string {
	return join(harnessDir(workingDir), "snapshots");
}

export function systemMarkdownPath(workingDir: string, chatGuid?: string): string {
	return chatGuid ? join(workingDir, chatGuid, "SYSTEM.md") : join(workingDir, "SYSTEM.md");
}

export function skillDir(workingDir: string, name: string, chatGuid?: string): string {
	return chatGuid ? join(workingDir, chatGuid, "skills", name) : join(workingDir, "skills", name);
}

export function formatSkillCatalog(entries: SkillCatalogEntry[]): string {
	if (entries.length === 0) return "(none yet)";
	return entries
		.map((entry) => {
			const where = entry.scope === "chat" ? `chat ${entry.chatGuid}` : "global";
			return `- ${entry.name} (${where}): ${entry.description}`;
		})
		.join("\n");
}

export function listSkillCatalog(workingDir: string, chatGuid?: string): SkillCatalogEntry[] {
	const entries = [...readSkillDir(join(workingDir, "skills"), "global")];
	if (chatGuid) {
		entries.push(...readSkillDir(join(workingDir, chatGuid, "skills"), "chat", chatGuid));
	} else {
		for (const guid of listWorkspaceChatGuids(workingDir)) {
			entries.push(...readSkillDir(join(workingDir, guid, "skills"), "chat", guid));
		}
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
}

export function parseSystemNotes(markdown: string): Array<{ id: string; text: string }> {
	const section = splitPromptNotes(markdown).section;
	const notes: Array<{ id: string; text: string }> = [];
	NOTE_BLOCK.lastIndex = 0;
	for (const match of section.matchAll(NOTE_BLOCK)) {
		const id = match[1];
		const text = match[2]?.trim();
		if (id && text) notes.push({ id, text });
	}
	return notes;
}

export function readSystemNotes(workingDir: string, chatGuid?: string): SystemNote[] {
	const path = systemMarkdownPath(workingDir, chatGuid);
	if (!existsSync(path)) return [];
	return parseSystemNotes(readFileSync(path, "utf8")).map((note) => ({
		...note,
		scope: chatGuid ? "chat" : "global",
		...(chatGuid ? { chatGuid } : {}),
	}));
}

export async function upsertSystemNote(
	workingDir: string,
	input: { text: string; id?: string; chatGuid?: string }
): Promise<SystemNote> {
	const text = sanitizeNoteText(input.text);
	if (!text) throw new Error("Prompt note text must not be empty");
	const path = systemMarkdownPath(workingDir, input.chatGuid);
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const existing = parseSystemNotes(current);
	const id = input.id ?? noteId(text, input.chatGuid);
	if (input.id && !existing.some((note) => note.id === input.id)) {
		throw new Error(`Unknown prompt note id: ${input.id}`);
	}
	const nextNotes = existing.some((note) => note.id === id)
		? existing.map((note) => (note.id === id ? { id, text } : note))
		: [...existing, { id, text }];
	await writeSystemMarkdown(path, renderSystemMarkdown(current, nextNotes));
	console.log(`[harness] prompt note upsert: ${input.chatGuid ?? "global"} id=${id} chars=${text.length}`);
	return {
		id,
		text,
		scope: input.chatGuid ? "chat" : "global",
		...(input.chatGuid ? { chatGuid: input.chatGuid } : {}),
	};
}

export async function deleteSystemNote(workingDir: string, id: string, chatGuid?: string): Promise<boolean> {
	const path = systemMarkdownPath(workingDir, chatGuid);
	if (!existsSync(path)) return false;
	const current = readFileSync(path, "utf8");
	const existing = parseSystemNotes(current);
	if (!existing.some((note) => note.id === id)) return false;
	await writeSystemMarkdown(
		path,
		renderSystemMarkdown(
			current,
			existing.filter((note) => note.id !== id)
		)
	);
	console.log(`[harness] prompt note delete: ${chatGuid ?? "global"} id=${id}`);
	return true;
}

export async function writeSkill(input: {
	workingDir: string;
	name: string;
	description: string;
	instructions: string;
	chatGuid?: string;
}): Promise<string> {
	const name = input.name.trim();
	assertSkillName(name);
	const description = input.description.trim();
	const instructions = input.instructions.trim();
	if (!description) throw new Error("Skill description must not be empty");
	if (!instructions) throw new Error("Skill instructions must not be empty");
	const dir = skillDir(input.workingDir, name, input.chatGuid);
	await mkdir(dir, { recursive: true });
	const content = `---\nname: ${name}\ndescription: ${description}\n---\n${instructions}\n`;
	await writeFile(join(dir, "SKILL.md"), content, "utf8");
	console.log(`[harness] skill write: ${input.chatGuid ?? "global"}/${name}`);
	return dir;
}

export async function deleteSkill(workingDir: string, name: string, chatGuid?: string): Promise<boolean> {
	assertSkillName(name);
	const dir = skillDir(workingDir, name, chatGuid);
	if (!existsSync(dir)) return false;
	await rm(dir, { recursive: true, force: true });
	console.log(`[harness] skill delete: ${chatGuid ?? "global"}/${name}`);
	return true;
}

export async function createHarnessSnapshot(
	workingDir: string,
	trigger: string,
	relativePaths: string[]
): Promise<SnapshotManifest> {
	const id = snapshotId();
	const created_at = new Date().toISOString();
	const snapshotRoot = join(snapshotsDir(workingDir), id);
	await mkdir(snapshotRoot, { recursive: true });
	const files: SnapshotFileRecord[] = [];
	for (const relativePath of uniquePaths(relativePaths)) {
		const source = join(workingDir, relativePath);
		if (!existsSync(source)) {
			files.push({ action: "created", relativePath });
			continue;
		}
		const destination = join(snapshotRoot, relativePath);
		await mkdir(dirname(destination), { recursive: true });
		await cp(source, destination, { recursive: true });
		files.push({ action: "backup", relativePath });
	}
	const manifest: SnapshotManifest = { id, created_at, trigger, files };
	await writeFile(join(snapshotRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	console.log(`[harness] snapshot created: ${id} files=${files.length} trigger=${trigger}`);
	return manifest;
}

export async function rollbackSnapshot(workingDir: string, snapshotIdValue: string): Promise<SnapshotManifest> {
	const snapshotRoot = join(snapshotsDir(workingDir), snapshotIdValue);
	const manifestPath = join(snapshotRoot, "manifest.json");
	if (!existsSync(manifestPath)) throw new Error(`Unknown snapshot: ${snapshotIdValue}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
	for (const file of [...manifest.files].reverse()) {
		const livePath = join(workingDir, file.relativePath);
		if (file.action === "created") {
			await rm(livePath, { recursive: true, force: true });
			continue;
		}
		const backupPath = join(snapshotRoot, file.relativePath);
		if (!existsSync(backupPath)) throw new Error(`Snapshot file missing: ${file.relativePath}`);
		await rm(livePath, { recursive: true, force: true });
		await mkdir(dirname(livePath), { recursive: true });
		await cp(backupPath, livePath, { recursive: true });
	}
	console.log(`[harness] snapshot rollback: ${snapshotIdValue} files=${manifest.files.length}`);
	return manifest;
}

export function assertSkillName(name: string): void {
	if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`Invalid skill name: ${name}`);
	if (RESERVED_SKILL_NAMES.has(name)) throw new Error(`Reserved skill name: ${name}`);
}

export function parseSkillMarkdown(
	content: string,
	fallbackName: string
): { name: string; description: string; instructions: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		return { name: fallbackName, description: fallbackName, instructions: content.trim() };
	}
	const frontmatter = match[1] ?? "";
	const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || fallbackName;
	const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || name;
	return { name, description, instructions: (match[2] ?? "").trim() };
}

function listWorkspaceChatGuids(workingDir: string): string[] {
	if (!existsSync(workingDir)) return [];
	return readdirSync(workingDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(workingDir, entry.name, "log.jsonl")))
		.map((entry) => entry.name);
}

function readSkillDir(root: string, scope: "global" | "chat", chatGuid?: string): SkillCatalogEntry[] {
	if (!existsSync(root)) return [];
	const entries: SkillCatalogEntry[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || RESERVED_SKILL_NAMES.has(entry.name)) continue;
		const skillMd = join(root, entry.name, "SKILL.md");
		if (!existsSync(skillMd)) continue;
		const parsed = parseSkillMarkdown(readFileSync(skillMd, "utf8"), entry.name);
		entries.push({
			name: parsed.name,
			description: parsed.description,
			scope,
			...(chatGuid ? { chatGuid } : {}),
			relativeDir: chatGuid ? join(chatGuid, "skills", entry.name) : join("skills", entry.name),
			instructions: parsed.instructions,
		});
	}
	return entries;
}

function splitPromptNotes(markdown: string): { section: string; rest: string } {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) => line === "# Prompt Notes");
	if (start < 0) return { section: "", rest: markdown };
	const end = lines.findIndex((line, index) => index > start && /^# /.test(line));
	const stop = end < 0 ? lines.length : end;
	return {
		section: lines.slice(start + 1, stop).join("\n"),
		rest: [...lines.slice(0, start), ...lines.slice(stop)].join("\n"),
	};
}

function renderSystemMarkdown(current: string, notes: Array<{ id: string; text: string }>): string {
	const rest = splitPromptNotes(current).rest.trim();
	if (notes.length === 0) return rest ? `${rest}\n` : "";
	const blocks = notes.map((note) => `<!-- id: ${note.id} -->\n${note.text}\n<!-- /id: ${note.id} -->`).join("\n\n");
	const notesSection = `# Prompt Notes\n\n${blocks}`;
	return rest ? `${notesSection}\n\n${rest}\n` : `${notesSection}\n`;
}

function sanitizeNoteText(text: string): string {
	return text.replaceAll("<!--", "").replaceAll("-->", "").trim();
}

function noteId(text: string, chatGuid?: string): string {
	return `note_${createHash("sha256")
		.update(`${chatGuid ?? "global"}\n${text}`)
		.digest("hex")
		.slice(0, 16)}`;
}

function snapshotId(): string {
	return `snap_${new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z")}`;
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.filter(Boolean))];
}

async function writeSystemMarkdown(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	if (!content.trim()) {
		await rm(path, { force: true });
		return;
	}
	await writeFile(path, content, "utf8");
}
