import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir, rmdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export const MEMORY_KINDS = ["fact", "event", "preference", "procedure"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemorySource {
	type: string;
	label: string;
	path?: string;
	line_start?: number;
	line_end?: number;
	block_hash?: string;
}

export interface StructuredMemoryItem {
	id: string;
	text: string;
	namespace: string;
	kind: MemoryKind;
	subjects: string[];
	event_time: string | null;
	sources: MemorySource[];
	importance: number;
	confidence: number;
	status: "active" | "superseded";
	created_at: string;
	supersedes_id?: string;
}

export interface SaveMemoryInput {
	text: string;
	namespace: string;
	kind: MemoryKind;
	subjects: string[];
	event_time: string | null;
	source: string;
	importance: number;
	confidence: number;
	supersedes_id?: string;
}

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/;

function memoryRoot(workingDir: string): string {
	return join(workingDir, "skills", "file-memory");
}

function namespaceRoot(workingDir: string): string {
	return join(memoryRoot(workingDir), "namespaces");
}

function namespacePath(workingDir: string, namespace: string): string {
	if (!NAMESPACE_PATTERN.test(namespace)) throw new Error(`Invalid memory namespace: ${namespace}`);
	return `${join(namespaceRoot(workingDir), ...namespace.split("/"))}.jsonl`;
}

function findJsonlFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const result: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) result.push(...findJsonlFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
	}
	return result.sort();
}

function namespaceFromPath(workingDir: string, path: string): string {
	return relative(namespaceRoot(workingDir), path)
		.replaceAll(sep, "/")
		.replace(/\.jsonl$/, "");
}

function parseJsonl(path: string): StructuredMemoryItem[] {
	if (!existsSync(path)) return [];
	const items: StructuredMemoryItem[] = [];
	for (const [index, raw] of readFileSync(path, "utf8").split("\n").entries()) {
		if (!raw.trim()) continue;
		try {
			items.push(JSON.parse(raw) as StructuredMemoryItem);
		} catch (error) {
			throw new Error(`Invalid memory JSONL ${path}:${index + 1}: ${error}`);
		}
	}
	return items;
}

export function readCoreMemory(workingDir: string): string {
	const path = join(memoryRoot(workingDir), "core.md");
	if (!existsSync(path)) return "(no core memory yet)";
	try {
		return readFileSync(path, "utf8").trim() || "(no core memory yet)";
	} catch (error) {
		console.warn(`[memory] failed to read core memory: ${error}`);
		return "(core memory unavailable)";
	}
}

export function listMemoryNamespaces(workingDir: string): Array<{ namespace: string; total: number; active: number }> {
	return findJsonlFiles(namespaceRoot(workingDir)).map((path) => {
		const items = parseJsonl(path);
		return {
			namespace: namespaceFromPath(workingDir, path),
			total: items.length,
			active: activeMemoryItems(items).length,
		};
	});
}

export function loadAllMemoryItems(workingDir: string): StructuredMemoryItem[] {
	return findJsonlFiles(namespaceRoot(workingDir)).flatMap(parseJsonl);
}

export function activeMemoryItems(items: StructuredMemoryItem[]): StructuredMemoryItem[] {
	const supersededIds = new Set(
		items.filter((item) => item.status === "active" && item.supersedes_id).map((item) => item.supersedes_id as string)
	);
	return items.filter((item) => item.status === "active" && !supersededIds.has(item.id));
}

export function loadMemoryNamespaces(workingDir: string, namespaces: string[]): StructuredMemoryItem[] {
	const selected = new Set(namespaces);
	for (const namespace of selected) namespacePath(workingDir, namespace);
	return activeMemoryItems(loadAllMemoryItems(workingDir)).filter((item) => selected.has(item.namespace));
}

export function searchMemory(
	workingDir: string,
	query: string,
	options: { namespaces?: string[]; limit?: number } = {}
): StructuredMemoryItem[] {
	const terms = query
		.toLowerCase()
		.split(/[\s,，、]+/)
		.filter(Boolean);
	const selected = options.namespaces ? new Set(options.namespaces) : undefined;
	const matches = activeMemoryItems(loadAllMemoryItems(workingDir))
		.filter((item) => !selected || selected.has(item.namespace))
		.map((item) => {
			const haystack = [item.text, item.namespace, item.kind, ...item.subjects].join(" ").toLowerCase();
			const lexical = terms.filter((term) => haystack.includes(term)).length;
			return { item, lexical };
		})
		.filter(({ lexical }) => terms.length === 0 || lexical > 0)
		.sort(
			(a, b) =>
				b.lexical - a.lexical ||
				b.item.importance - a.item.importance ||
				(b.item.event_time ?? "").localeCompare(a.item.event_time ?? "")
		);
	return matches.slice(0, options.limit ?? 10).map(({ item }) => item);
}

function validateSaveInput(input: SaveMemoryInput): void {
	if (!input.text.trim()) throw new Error("Memory text must not be empty");
	if (!NAMESPACE_PATTERN.test(input.namespace)) throw new Error(`Invalid memory namespace: ${input.namespace}`);
	if (!MEMORY_KINDS.includes(input.kind)) throw new Error(`Invalid memory kind: ${input.kind}`);
	if (input.event_time !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.event_time)) {
		throw new Error("event_time must be YYYY-MM-DD or null");
	}
	if (!input.source.trim()) throw new Error("Memory source must not be empty");
	if (input.importance < 0 || input.importance > 1 || input.confidence < 0 || input.confidence > 1) {
		throw new Error("importance and confidence must be between 0 and 1");
	}
}

function stableKey(input: Omit<SaveMemoryInput, "source" | "importance" | "confidence">): string {
	return JSON.stringify({
		text: input.text.trim().replace(/\s+/g, " "),
		namespace: input.namespace,
		kind: input.kind,
		subjects: [...new Set(input.subjects.map((subject) => subject.trim()).filter(Boolean))].sort(),
		event_time: input.event_time,
		supersedes_id: input.supersedes_id,
	});
}

async function withWriteLock<T>(workingDir: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = join(memoryRoot(workingDir), ".write-lock");
	const deadline = Date.now() + 5_000;
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error("Timed out waiting for memory write lock");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		return await operation();
	} finally {
		await rmdir(lockPath).catch(() => {});
	}
}

export async function saveMemory(
	workingDir: string,
	input: SaveMemoryInput
): Promise<{ added: boolean; item: StructuredMemoryItem }> {
	validateSaveInput(input);
	return withWriteLock(workingDir, async () => {
		const existing = loadAllMemoryItems(workingDir);
		const ids = new Set(existing.map((item) => item.id));
		if (input.supersedes_id && !ids.has(input.supersedes_id)) {
			throw new Error(`Unknown supersedes_id: ${input.supersedes_id}`);
		}
		const normalized = stableKey(input);
		const id = `mem_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
		const duplicate = existing.find(
			(item) =>
				item.id === id ||
				stableKey({
					text: item.text,
					namespace: item.namespace,
					kind: item.kind,
					subjects: item.subjects,
					event_time: item.event_time,
					supersedes_id: item.supersedes_id,
				}) === normalized
		);
		if (duplicate) return { added: false, item: duplicate };

		const item: StructuredMemoryItem = {
			id,
			text: input.text.trim(),
			namespace: input.namespace,
			kind: input.kind,
			subjects: [...new Set(input.subjects.map((subject) => subject.trim()).filter(Boolean))].sort(),
			event_time: input.event_time,
			sources: [{ type: "chat", label: input.source.trim() }],
			importance: input.importance,
			confidence: input.confidence,
			status: "active",
			created_at: new Date().toISOString(),
			...(input.supersedes_id ? { supersedes_id: input.supersedes_id } : {}),
		};
		const path = namespacePath(workingDir, input.namespace);
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(item)}\n`, "utf8");
		return { added: true, item };
	});
}
