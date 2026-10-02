import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseMemoryQuery, readMemoryView } from "../memory-view.js";
import { SYSTEM_CONTEXT_MAX_BYTES, readSystemContext, readSystemSummary } from "../system-context.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "system-context-"));
	roots.push(root);
	return root;
}
function put(root: string, name: string, content: string) {
	const path = join(root, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("reads only current summaries and never auto-injects historical commands", () => {
	const root = fixture();
	put(root, "SYSTEM.md", "Current configuration");
	put(root, "system-history/2026-09-06.md", "OBSOLETE HISTORY: run old migration");
	put(root, "iMessage;+;example/SYSTEM.md", "Scoped configuration");
	const result = readSystemContext(root, join(root, "iMessage;+;example"));
	expect(result).toContain("Current configuration");
	expect(result).toContain("Scoped configuration");
	expect(result).not.toContain("OBSOLETE");
	expect(readSystemContext(root, root).match(/Current configuration/g)).toHaveLength(1);
});
it("ignores later log appends after the explicit summary boundary", () => {
	const root = fixture();
	put(root, "SYSTEM.md", "Current configuration\n<!-- END SYSTEM SUMMARY -->\nOLD WRITER APPENDED HISTORY");
	expect(readSystemSummary(root)).toBe("Current configuration");
});
it("enforces the byte cap even if an old writer appends a huge log", () => {
	const root = fixture();
	put(root, "SYSTEM.md", `${"a".repeat(SYSTEM_CONTEXT_MAX_BYTES)}SECRET TAIL${"b".repeat(200_000)}`);
	const before = readFileSync(join(root, "SYSTEM.md"));
	const result = readSystemSummary(root);
	expect(result).toContain("8192-byte summary limit");
	expect(result).not.toContain("SECRET TAIL");
	expect(Buffer.byteLength(result)).toBeLessThan(8600);
	expect(readFileSync(join(root, "SYSTEM.md"))).toEqual(before);
});
it("does not mark an exact limit document truncated and safely handles split UTF-8 characters", () => {
	const root = fixture();
	put(root, "SYSTEM.md", "a".repeat(SYSTEM_CONTEXT_MAX_BYTES));
	expect(readSystemSummary(root)).toHaveLength(SYSTEM_CONTEXT_MAX_BYTES);
	put(root, "SYSTEM.md", `${"a".repeat(SYSTEM_CONTEXT_MAX_BYTES - 1)}中文`);
	const value = readSystemSummary(root);
	expect(value).not.toContain("�");
	expect(value).toContain("exceeded");
});
it("handles missing, empty and nonregular summaries without loading an archive fallback", () => {
	const root = fixture();
	put(root, "system-history/2026-09-06.md", "HISTORY ONLY");
	expect(readSystemContext(root)).toBe("");
	put(root, "SYSTEM.md", "  \n");
	expect(readSystemSummary(root)).toBe("");
	rmSync(join(root, "SYSTEM.md"));
	mkdirSync(join(root, "SYSTEM.md"));
	expect(readSystemSummary(root)).toContain("unavailable");
});
it("does not follow a linked summary file", () => {
	const root = fixture();
	put(root, "outside", "SECRET VALUE");
	symlinkSync(join(root, "outside"), join(root, "SYSTEM.md"));
	expect(readSystemSummary(root)).not.toContain("SECRET VALUE");
});
it("preserves the read-only system view with allowlisted history and stable opaque IDs", () => {
	const root = fixture();
	put(root, "SYSTEM.md", "CURRENT");
	put(root, "system-history/2026-09-06.md", "DAILY HISTORY");
	put(root, "system-history/legacy-before-2026-09-06.md", "ORIGINAL HISTORY");
	put(root, "system-history/auth.json", "SECRET");
	put(root, "system-history/arbitrary.md", "SECRET");
	const query = parseMemoryQuery(new URLSearchParams("view=system"));
	const data = readMemoryView(root, query);
	expect(data.documents).toHaveLength(3);
	expect(data.documents[0].content).toBe("CURRENT");
	const daily = data.documents.find((d) => d.label === "历史 / 2026-09-06.md");
	expect(daily).toBeDefined();
	const selected = readMemoryView(root, { ...query, doc: daily?.id || "" });
	expect(selected.documents.find((d) => d.id === daily?.id)?.content).toBe("DAILY HISTORY");
	expect(JSON.stringify(data)).not.toContain("SECRET");
	expect(readSystemContext(root)).not.toContain("HISTORY");
});
it("rejects symlinked history files and directories", () => {
	const root = fixture();
	put(root, "SYSTEM.md", "CURRENT");
	put(root, "outside/2026-09-06.md", "SECRET");
	symlinkSync(join(root, "outside"), join(root, "system-history"));
	const query = parseMemoryQuery(new URLSearchParams("view=system"));
	let data = readMemoryView(root, query);
	expect(data.documents).toHaveLength(1);
	expect(data.diagnostics.length).toBeGreaterThan(0);
	rmSync(join(root, "system-history"));
	mkdirSync(join(root, "system-history"));
	symlinkSync(join(root, "outside/2026-09-06.md"), join(root, "system-history/2026-09-06.md"));
	data = readMemoryView(root, query);
	expect(data.documents).toHaveLength(1);
	expect(JSON.stringify(data)).not.toContain("SECRET");
});
it("the agent uses the bounded reader and instructs summary/history separation", () => {
	const source = readFileSync(new URL("../agent.ts", import.meta.url), "utf8");
	expect(source).toContain("const customPrompt = readSystemContext(workingDir, chatDir)");
	expect(source).not.toContain("function getCustomPrompt");
	expect(source).toContain("system-history/YYYY-MM-DD.md");
	expect(source).toContain("History is NEVER automatically injected");
});
