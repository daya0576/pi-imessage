import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listMemoryNamespaces, loadMemoryNamespaces, readCoreMemory, saveMemory, searchMemory } from "../memory.js";

function record(overrides: Record<string, unknown>) {
	return {
		id: "base",
		text: "base fact",
		namespace: "health/paipai",
		kind: "event",
		subjects: ["派派"],
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
	const memoryRoot = join(root, "skills", "file-memory");
	mkdirSync(join(memoryRoot, "namespaces", "health"), { recursive: true });
	mkdirSync(join(memoryRoot, "namespaces", "work"), { recursive: true });
	writeFileSync(join(memoryRoot, "core.md"), "stable core fact\n");
	const health = [
		record({ id: "old", text: "派派肺炎住院" }),
		record({ id: "new", text: "派派因腺病毒肺炎住院", supersedes_id: "old" }),
		record({
			id: "cc",
			text: "CC发烧",
			namespace: "health/cc",
			subjects: ["CC"],
			event_time: "2026-07-03",
		}),
	];
	writeFileSync(
		join(memoryRoot, "namespaces", "health", "paipai.jsonl"),
		`${health
			.slice(0, 2)
			.map((item) => JSON.stringify(item))
			.join("\n")}\n`
	);
	writeFileSync(join(memoryRoot, "namespaces", "health", "cc.jsonl"), `${JSON.stringify(health[2])}\n`);
	writeFileSync(
		join(memoryRoot, "namespaces", "work", "henry.jsonl"),
		`${JSON.stringify(record({ id: "work", text: "Henry joined Optiver", namespace: "work/henry", subjects: ["Henry"] }))}\n`
	);
	return root;
}

describe("structured memory v2", () => {
	it("reads small always-on core memory", () => {
		expect(readCoreMemory(fixture())).toBe("stable core fact");
	});

	it("lists namespace loading units with active counts", () => {
		expect(listMemoryNamespaces(fixture())).toEqual([
			{ namespace: "health/cc", total: 1, active: 1 },
			{ namespace: "health/paipai", total: 2, active: 1 },
			{ namespace: "work/henry", total: 1, active: 1 },
		]);
	});

	it("loads complete selected namespaces and hides superseded records", () => {
		const items = loadMemoryNamespaces(fixture(), ["health/paipai", "health/cc"]);
		expect(items.map((item) => item.id).sort()).toEqual(["cc", "new"]);
	});

	it("does not perform automatic query routing but supports explicit correction search", () => {
		const items = searchMemory(fixture(), "腺病毒", { namespaces: ["health/paipai"] });
		expect(items.map((item) => item.id)).toEqual(["new"]);
	});

	it("appends idempotently and preserves a superseding correction", async () => {
		const root = fixture();
		const input = {
			text: "派派已经出院",
			namespace: "health/paipai",
			kind: "event" as const,
			subjects: ["派派"],
			event_time: "2026-07-05",
			source: "private chat message on 2026-07-05",
			importance: 0.9,
			confidence: 1,
			supersedes_id: "new",
		};
		const first = await saveMemory(root, input);
		const second = await saveMemory(root, { ...input, source: "same fact repeated later" });
		expect(first.added).toBe(true);
		expect(second.added).toBe(false);
		expect(second.item.id).toBe(first.item.id);
		expect(loadMemoryNamespaces(root, ["health/paipai"]).map((item) => item.id)).toEqual([first.item.id]);
	});

	it("allows unknown factual dates without inventing one", async () => {
		const result = await saveMemory(fixture(), {
			text: "Henry prefers concise replies",
			namespace: "preference/henry",
			kind: "preference",
			subjects: ["Henry"],
			event_time: null,
			source: "legacy memory migration",
			importance: 0.7,
			confidence: 1,
		});
		expect(result.item.event_time).toBeNull();
	});
});
