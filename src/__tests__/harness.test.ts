import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createHarnessSnapshot,
	deleteSkill,
	deleteSystemNote,
	listSkillCatalog,
	parseSystemNotes,
	rollbackSnapshot,
	upsertSystemNote,
	writeSkill,
} from "../harness.js";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "pi-harness-"));
}

describe("SYSTEM.md prompt notes", () => {
	it("creates, updates, and deletes notes without dropping the env log", async () => {
		const root = workspace();
		writeFileSync(join(root, "SYSTEM.md"), "# Environment\n- installed foo\n");

		const created = await upsertSystemNote(root, { text: "Keep group replies short." });
		const updated = await upsertSystemNote(root, { id: created.id, text: "Keep group replies very short." });
		expect(updated.id).toBe(created.id);

		const markdown = readFileSync(join(root, "SYSTEM.md"), "utf8");
		expect(parseSystemNotes(markdown)).toEqual([{ id: created.id, text: "Keep group replies very short." }]);
		expect(markdown).toContain("# Environment\n- installed foo");

		await deleteSystemNote(root, created.id);
		expect(parseSystemNotes(readFileSync(join(root, "SYSTEM.md"), "utf8"))).toEqual([]);
		expect(readFileSync(join(root, "SYSTEM.md"), "utf8")).toContain("installed foo");
	});
});

describe("skill catalog", () => {
	it("lists global skills and ignores file-memory", async () => {
		const root = workspace();
		mkdirSync(join(root, "skills", "file-memory"), { recursive: true });
		writeFileSync(
			join(root, "skills", "file-memory", "SKILL.md"),
			"---\nname: file-memory\ndescription: internal\n---\n"
		);
		await writeSkill({
			workingDir: root,
			name: "search",
			description: "Web search",
			instructions: "Run search/run.sh",
		});

		expect(listSkillCatalog(root).map((entry) => entry.name)).toEqual(["search"]);
	});
});

describe("harness snapshots", () => {
	it("restores SYSTEM.md and removes a created skill", async () => {
		const root = workspace();
		writeFileSync(join(root, "SYSTEM.md"), "# Environment\n- before\n");
		const snapshot = await createHarnessSnapshot(root, "test", ["SYSTEM.md", "skills/weather"]);

		await upsertSystemNote(root, { text: "Do not mention thunderstorm walks." });
		await writeSkill({
			workingDir: root,
			name: "weather",
			description: "Weather",
			instructions: "Call weather.py",
		});
		expect(existsSync(join(root, "skills", "weather", "SKILL.md"))).toBe(true);

		await rollbackSnapshot(root, snapshot.id);
		expect(readFileSync(join(root, "SYSTEM.md"), "utf8")).toContain("- before");
		expect(parseSystemNotes(readFileSync(join(root, "SYSTEM.md"), "utf8"))).toEqual([]);
		expect(existsSync(join(root, "skills", "weather"))).toBe(false);
	});

	it("restores a deleted skill directory", async () => {
		const root = workspace();
		await writeSkill({
			workingDir: root,
			name: "search",
			description: "Search",
			instructions: "Run search",
		});
		const snapshot = await createHarnessSnapshot(root, "test", ["skills/search"]);
		await deleteSkill(root, "search");
		expect(existsSync(join(root, "skills", "search"))).toBe(false);

		await rollbackSnapshot(root, snapshot.id);
		expect(readFileSync(join(root, "skills", "search", "SKILL.md"), "utf8")).toContain("Run search");
	});
});
