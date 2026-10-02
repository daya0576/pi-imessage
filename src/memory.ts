import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

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

// Exact gzip/base64 snapshot of the CLI selected by pi-memory on mini.
// Source: dotfile/pi-config/agent/memory/memory_cli.py at 6bef3d978af37c0ceb0c59587c071eee140ff004.
// SHA-256 (uncompressed): df63bf7bc028636803bd7f14914a71d38e569d92006435bfdd71efb66a910dd4.
// Embedded to ship with both src and dist without a separate build/copy step.
const SHARED_MEMORY_CLI = [
	"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",
].join("");

// Only transport adaptation: the byte-identical backend owns all write semantics.
// Give it a script-relative filename inside this store (no cwd/HOME dependency),
// without replacing any existing runtime memory_cli.py or requiring a data migration.
const WRITE_BRIDGE = String.raw`
import base64, gzip, json, sys
from pathlib import Path
payload = json.load(sys.stdin)
script = str(Path(sys.argv[1]).resolve() / ".shared-memory-cli.py")
backend = {"__file__": script, "__name__": "shared_memory_cli"}
try:
    if Path(script).is_symlink():
        raise ValueError("virtual memory backend path must not be a symlink")
    exec(compile(gzip.decompress(base64.b64decode(payload["backend"])), script, "exec"), backend)
    data = payload["input"]
    data["source_label"] = data.pop("source")
    item, added = backend["append_item"](**data)
    print(json.dumps({"added": added, "item": item}, ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

export async function saveMemory(
	workingDir: string,
	input: SaveMemoryInput
): Promise<{ added: boolean; item: StructuredMemoryItem }> {
	validateSaveInput(input);
	const root = resolve(memoryRoot(workingDir));
	await mkdir(root, { recursive: true });
	return new Promise((resolveResult, reject) => {
		const child = spawn("python3", ["-c", WRITE_BRIDGE, root], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.stdin.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				const message = stderr
					.trim()
					.replace(/^unknown supersedes id: /, "Unknown supersedes_id: ")
					.replace(/^timed out waiting for memory write lock$/, "Timed out waiting for memory write lock");
				reject(new Error(message || `Memory backend exited with code ${code}`));
				return;
			}
			try {
				resolveResult(JSON.parse(stdout));
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.end(JSON.stringify({ backend: SHARED_MEMORY_CLI, input }));
	});
}
