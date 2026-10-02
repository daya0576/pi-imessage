import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	listMemoryNamespaces,
	loadAllMemoryItems,
	loadMemoryNamespaces,
	readCoreMemory,
	saveMemory,
	searchMemory,
} from "../memory.js";

// Verify and exercise the actual vendored bytes, not a separately reimplemented writer.
const memorySource = readFileSync(new URL("../memory.ts", import.meta.url), "utf8");
const encodedBackend = memorySource.split("const SHARED_MEMORY_CLI = [")[1].split("].join")[0];
const backendBytes = gunzipSync(
	Buffer.from([...encodedBackend.matchAll(/"([^"]+)"/g)].map((match) => match[1]).join(""), "base64")
);
const run = promisify(execFile);
const input = {
	text: "A durable fact",
	namespace: "project/alpha",
	kind: "fact" as const,
	subjects: ["Demo"],
	event_time: null,
	source: "synthetic chat fixture",
	importance: 0.7,
	confidence: 1,
};

function installCli(root: string): string {
	const path = join(root, "skills", "file-memory", "memory_cli.py");
	mkdirSync(join(root, "skills", "file-memory"), { recursive: true });
	writeFileSync(path, backendBytes);
	return path;
}

async function cliSave(path: string, overrides: { text?: string; supersedes?: string } = {}) {
	const args = [
		path,
		"save",
		`--text=${overrides.text ?? input.text}`,
		`--namespace=${input.namespace}`,
		`--kind=${input.kind}`,
		"--subjects",
		"Demo",
		`--source=${input.source}`,
		`--importance=${input.importance}`,
		`--confidence=${input.confidence}`,
	];
	if (overrides.supersedes) args.push(`--supersedes=${overrides.supersedes}`);
	const { stdout } = await run("python3", args, { cwd: tmpdir() });
	return JSON.parse(stdout);
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function record(overrides: Record<string, unknown>) {
	return {
		id: "base",
		text: "base fact",
		namespace: "project/alpha",
		kind: "event",
		subjects: ["示例项目"],
		event_time: "2026-07-02",
		sources: [{ type: "test", label: "fixture" }],
		importance: 0.9,
		confidence: 1,
		status: "active",
		created_at: "2026-07-02T00:00:00Z",
		...overrides,
	};
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-"));
	roots.push(root);
	const memoryRoot = join(root, "skills", "file-memory");
	mkdirSync(join(memoryRoot, "namespaces", "project"), { recursive: true });
	mkdirSync(join(memoryRoot, "namespaces", "work"), { recursive: true });
	writeFileSync(join(memoryRoot, "core.md"), "stable core fact\n");
	const projects = [
		record({ id: "old", text: "示例项目采用旧格式" }),
		record({ id: "new", text: "示例项目采用新的校验格式", supersedes_id: "old" }),
		record({
			id: "beta",
			text: "测试设备离线",
			namespace: "project/beta",
			subjects: ["测试设备"],
			event_time: "2026-07-03",
		}),
	];
	writeFileSync(
		join(memoryRoot, "namespaces", "project", "alpha.jsonl"),
		`${projects
			.slice(0, 2)
			.map((item) => JSON.stringify(item))
			.join("\n")}\n`
	);
	writeFileSync(join(memoryRoot, "namespaces", "project", "beta.jsonl"), `${JSON.stringify(projects[2])}\n`);
	writeFileSync(
		join(memoryRoot, "namespaces", "work", "demo.jsonl"),
		`${JSON.stringify(record({ id: "work", text: "Demo project started", namespace: "work/demo", subjects: ["Demo"] }))}\n`
	);
	return root;
}

describe("structured memory v2", () => {
	it("vendors the byte-exact pi-memory CLI version with traceable provenance", () => {
		expect(createHash("sha256").update(backendBytes).digest("hex")).toBe(
			"df63bf7bc028636803bd7f14914a71d38e569d92006435bfdd71efb66a910dd4"
		);
	});

	it("creates a missing store without depending on a runtime CLI, cwd, or HOME", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-fresh-"));
		roots.push(root);
		const saved = await saveMemory(root, {
			...input,
			text: "--leading option\n中文 ' \" $()",
			subjects: ["--Demo", "Demo", "Demo"],
		});
		expect(saved.added).toBe(true);
		expect(saved.item.text).toBe("--leading option\n中文 ' \" $()");
		expect(saved.item.subjects).toEqual(["--Demo", "Demo"]);
		expect(loadAllMemoryItems(root)).toEqual([saved.item]);
		expect(existsSync(join(root, "skills", "file-memory", "memory_cli.py"))).toBe(false);
		expect(existsSync(join(root, "skills", "file-memory", ".write-lock"))).toBe(false);
	});

	it("shares IDs, deduplication, and superseding corrections with the CLI in both directions", async () => {
		const root = fixture();
		const cli = installCli(root);
		const initial = await cliSave(cli);
		expect(await saveMemory(root, { ...input, source: "another source" })).toEqual({
			added: false,
			item: initial.item,
		});
		const corrected = await saveMemory(root, { ...input, text: "Corrected fact", supersedes_id: initial.item.id });
		expect(await cliSave(cli, { text: "Corrected fact", supersedes: initial.item.id })).toEqual({
			added: false,
			item: corrected.item,
		});
		const independent = fixture();
		expect((await saveMemory(independent, input)).item.id).toBe(initial.item.id);
		expect(loadMemoryNamespaces(root, [input.namespace]).map((item) => item.id)).toEqual(["new", corrected.item.id]);
		expect(readFileSync(cli)).toEqual(backendBytes);
	});

	it("deduplicates legacy TS records by content without rewriting IDs or existing bytes", async () => {
		const root = fixture();
		const path = join(root, "skills", "file-memory", "namespaces", "project", "alpha.jsonl");
		const bytes = `${JSON.stringify(record({ ...input, id: "legacy-ts-id", sources: [{ type: "chat", label: input.source }] }))}\n`;
		writeFileSync(path, bytes);
		const saved = await saveMemory(root, input);
		expect(saved.added).toBe(false);
		expect(saved.item.id).toBe("legacy-ts-id");
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it("serializes concurrent TS and CLI writers through the same store lock", async () => {
		const root = fixture();
		const cli = installCli(root);
		const results = await Promise.all([
			...Array.from({ length: 4 }, () => saveMemory(root, input)),
			...Array.from({ length: 4 }, () => cliSave(cli)),
		]);
		expect(results.filter((result) => result.added)).toHaveLength(1);
		expect(new Set(results.map((result) => result.item.id)).size).toBe(1);
		expect(loadAllMemoryItems(root).filter((item) => item.text === input.text)).toHaveLength(1);
		expect(existsSync(join(root, "skills", "file-memory", ".write-lock"))).toBe(false);
	});

	it.each([
		[{ text: " " }, "Memory text must not be empty"],
		[{ namespace: "../other" }, "Invalid memory namespace"],
		[{ kind: "invalid" }, "Invalid memory kind"],
		[{ event_time: "yesterday" }, "event_time must be YYYY-MM-DD or null"],
		[{ source: " " }, "Memory source must not be empty"],
		[{ importance: -1 }, "importance and confidence must be between 0 and 1"],
		[{ confidence: 2 }, "importance and confidence must be between 0 and 1"],
	] as const)("preserves public validation for %j", async (overrides, message) => {
		await expect(saveMemory(fixture(), { ...input, ...overrides } as Parameters<typeof saveMemory>[1])).rejects.toThrow(
			message
		);
	});

	it("rejects unknown corrections and invalid factual dates without appending", async () => {
		const root = fixture();
		const before = loadAllMemoryItems(root);
		await expect(saveMemory(root, { ...input, supersedes_id: "missing" })).rejects.toThrow(
			"Unknown supersedes_id: missing"
		);
		await expect(saveMemory(root, { ...input, event_time: "2026-02-30" })).rejects.toThrow();
		expect(loadAllMemoryItems(root)).toEqual(before);
	});

	it("respects a lock held by another writer without removing it", async () => {
		const root = fixture();
		const lock = join(root, "skills", "file-memory", ".write-lock");
		const before = loadAllMemoryItems(root);
		mkdirSync(lock);
		await expect(saveMemory(root, input)).rejects.toThrow("Timed out waiting for memory write lock");
		expect(existsSync(lock)).toBe(true);
		expect(loadAllMemoryItems(root)).toEqual(before);
	}, 10_000);

	it("refuses a virtual backend symlink rather than writing into another store", async () => {
		const root = fixture();
		const other = fixture();
		const cli = installCli(other);
		symlinkSync(cli, join(root, "skills", "file-memory", ".shared-memory-cli.py"));
		const before = loadAllMemoryItems(other);
		await expect(saveMemory(root, input)).rejects.toThrow("virtual memory backend path must not be a symlink");
		expect(loadAllMemoryItems(other)).toEqual(before);
	});

	it("fails closed on malformed JSONL and releases the backend lock", async () => {
		const root = fixture();
		const path = join(root, "skills", "file-memory", "namespaces", "project", "alpha.jsonl");
		writeFileSync(path, "not json\n");
		await expect(saveMemory(root, input)).rejects.toThrow("alpha.jsonl:1");
		expect(readFileSync(path, "utf8")).toBe("not json\n");
		expect(existsSync(join(root, "skills", "file-memory", ".write-lock"))).toBe(false);
	});

	it("reads small always-on core memory", () => {
		expect(readCoreMemory(fixture())).toBe("stable core fact");
	});

	it("lists namespace loading units with active counts", () => {
		expect(listMemoryNamespaces(fixture())).toEqual([
			{ namespace: "project/alpha", total: 2, active: 1 },
			{ namespace: "project/beta", total: 1, active: 1 },
			{ namespace: "work/demo", total: 1, active: 1 },
		]);
	});

	it("loads complete selected namespaces and hides superseded records", () => {
		const items = loadMemoryNamespaces(fixture(), ["project/alpha", "project/beta"]);
		expect(items.map((item) => item.id).sort()).toEqual(["beta", "new"]);
	});

	it("does not perform automatic query routing but supports explicit correction search", () => {
		const items = searchMemory(fixture(), "校验格式", { namespaces: ["project/alpha"] });
		expect(items.map((item) => item.id)).toEqual(["new"]);
	});

	it("appends idempotently and preserves a superseding correction", async () => {
		const root = fixture();
		const input = {
			text: "示例项目校验已完成",
			namespace: "project/alpha",
			kind: "event" as const,
			subjects: ["示例项目"],
			event_time: "2026-07-05",
			source: "synthetic fixture on 2026-07-05",
			importance: 0.9,
			confidence: 1,
			supersedes_id: "new",
		};
		const first = await saveMemory(root, input);
		const second = await saveMemory(root, { ...input, source: "same fact repeated later" });
		expect(first.added).toBe(true);
		expect(second.added).toBe(false);
		expect(second.item.id).toBe(first.item.id);
		expect(loadMemoryNamespaces(root, ["project/alpha"]).map((item) => item.id)).toEqual([first.item.id]);
	});

	it("allows unknown factual dates without inventing one", async () => {
		const result = await saveMemory(fixture(), {
			text: "Demo replies use compact text",
			namespace: "preference/demo",
			kind: "preference",
			subjects: ["Demo"],
			event_time: null,
			source: "legacy memory migration",
			importance: 0.7,
			confidence: 1,
		});
		expect(result.item.event_time).toBeNull();
	});
});
