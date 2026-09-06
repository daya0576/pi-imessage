import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listMemoryNamespaces, loadMemoryNamespaces, readCoreMemory, saveMemory, searchMemory } from "../memory.js";

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
