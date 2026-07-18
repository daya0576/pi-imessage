import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatStructuredMemory, readCoreMemory, retrieveStructuredMemory } from "../memory.js";

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-"));
	const memoryRoot = join(root, "skills", "file-memory");
	mkdirSync(join(memoryRoot, "categories"), { recursive: true });
	writeFileSync(join(memoryRoot, "core.md"), "stable core fact\n");
	const records = [
		{
			id: "old",
			text: "派派肺炎住院",
			category: "health",
			subjects: ["派派"],
			event_time: "2026-07-02",
			importance: 0.9,
			confidence: 1,
			status: "active",
		},
		{
			id: "new",
			text: "派派因腺病毒肺炎住院",
			category: "health",
			subjects: ["派派"],
			event_time: "2026-07-02",
			importance: 0.9,
			confidence: 1,
			status: "active",
			supersedes_id: "old",
		},
		{
			id: "cc",
			text: "CC发烧",
			category: "health",
			subjects: ["CC"],
			event_time: "2026-07-03",
			importance: 0.6,
			confidence: 0.8,
			status: "active",
		},
	];
	writeFileSync(
		join(memoryRoot, "categories", "health.jsonl"),
		`${records.map((x) => JSON.stringify(x)).join("\n")}\n`
	);
	return root;
}

describe("structured memory", () => {
	it("reads small always-on core memory", () => {
		expect(readCoreMemory(fixture())).toBe("stable core fact");
	});

	it("retrieves the right subject and hides superseded records", () => {
		const items = retrieveStructuredMemory(fixture(), "派派上次肺炎住院是什么时候");
		expect(items.map((item) => item.id)).toEqual(["new"]);
	});

	it("formats retrieved records for prompt injection", () => {
		const items = retrieveStructuredMemory(fixture(), "CC发烧");
		const formatted = formatStructuredMemory(items);
		expect(formatted).toContain("active records only");
		expect(formatted).toContain("CC发烧");
		expect(formatted).not.toContain("派派");
	});

	it("does not retrieve from transport metadata alone", () => {
		expect(retrieveStructuredMemory(fixture(), "[DM from +8617612150403] 继续？")).toEqual([]);
	});
});
