import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryQueryError, memoryLink, parseMemoryQuery, readMemoryView } from "../memory-view.js";
import { activeMemoryItems, loadAllMemoryItems } from "../memory.js";
import { handleMemoryRequest } from "../web/memory.js";
import * as render from "../web/render.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "memory-view-"));
	roots.push(root);
	mkdirSync(join(root, "skills/file-memory/namespaces"), { recursive: true });
	return root;
}
function put(root: string, file: string, value: string) {
	const path = join(root, file);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, value);
}
function record(id: string, changes: Record<string, unknown> = {}) {
	return {
		id,
		text: `Synthetic fact ${id}`,
		namespace: "project/demo",
		kind: "fact",
		subjects: ["Example"],
		event_time: null,
		created_at: "2026-09-01T00:00:00Z",
		sources: [{ type: "test", label: "fictional source" }],
		importance: 0.6,
		confidence: 0.9,
		status: "active",
		...changes,
	};
}
function records(root: string, rows: ReturnType<typeof record>[]) {
	const grouped = new Map<string, unknown[]>();
	for (const row of rows) {
		const group = grouped.get(row.namespace) || [];
		group.push(row);
		grouped.set(row.namespace, group);
	}
	for (const [namespace, group] of grouped)
		put(
			root,
			`skills/file-memory/namespaces/${namespace}.jsonl`,
			`${group.map((row) => JSON.stringify(row)).join("\n")}\n`
		);
}
function view(root: string, query = "") {
	return readMemoryView(root, parseMemoryQuery(new URLSearchParams(query)), join(root, "agent"));
}

describe("read-only memory browser", () => {
	it("defaults to canonical effective records, applying cross-namespace corrections before filtering", () => {
		const root = fixture();
		records(root, [record("old"), record("new", { namespace: "work/example", supersedes_id: "old" })]);
		const data = view(root);
		expect(data.rows.map((row) => row.item.id)).toEqual(
			activeMemoryItems(loadAllMemoryItems(root)).map((row) => row.id)
		);
		expect(data.counts).toEqual({ all: 2, effective: 1, historical: 1, uncertain: 0 });
		expect(view(root, "namespace=project/demo").rows).toHaveLength(0);
		expect(view(root, "namespace=project/demo&status=historical").rows[0].item.id).toBe("old");
	});
	it("shows all transitive predecessors, successors and branches regardless of current filters", () => {
		const root = fixture();
		records(root, [
			record("a"),
			record("b", { supersedes_id: "a", namespace: "work/example" }),
			record("c", { supersedes_id: "b" }),
			record("d", { supersedes_id: "b", namespace: "work/example" }),
		]);
		const key = view(root, "status=all").rows.find((row) => row.item.id === "b")?.key;
		const data = view(root, `namespace=project/demo&q=missing&record=${key}`);
		expect(data.rows).toHaveLength(0);
		expect(data.history.map((row) => row.item.id)).toEqual(["a", "b", "c", "d"]);
	});
	it("retains explicit superseded status with exact canonical parity", () => {
		const root = fixture();
		records(root, [
			record("a"),
			record("b", { status: "superseded", supersedes_id: "a" }),
			record("c", { supersedes_id: "b" }),
		]);
		expect(view(root).rows.map((row) => row.item.id)).toEqual(["a", "c"]);
	});
	it("searches provenance, subjects, kind and text while preserving filter pagination", () => {
		const root = fixture();
		records(
			root,
			Array.from({ length: 25 }, (_, i) =>
				record(`id-${String(i).padStart(2, "0")}`, {
					kind: "event",
					sources: [{ type: "test", label: "RELEASE evidence", path: "docs/synthetic.txt" }],
				})
			)
		);
		const data = view(root, "q=release%20synthetic&kind=event&size=10&page=2");
		expect(data.counts.all).toBe(25);
		expect(data.pages).toBe(3);
		expect(data.rows.map((row) => row.item.id)).toEqual(Array.from({ length: 10 }, (_, i) => `id-${i + 10}`));
		const href = memoryLink(data.query, { page: 3 });
		expect(parseMemoryQuery(new URL(href, "http://localhost").searchParams)).toMatchObject({
			q: "release synthetic",
			kind: "event",
			size: 10,
			page: 3,
		});
		expect(view(root, "page=999&size=10").page).toBe(3);
	});
	it("orders real timestamp instants across timezone offsets and leaves unknown dates last", () => {
		const root = fixture();
		records(root, [
			record("earlier", { created_at: "2026-09-02T01:00:00+08:00" }),
			record("later", { created_at: "2026-09-01T23:00:00Z" }),
			record("unknown", { created_at: "" }),
		]);
		expect(view(root, "status=all").rows.map((row) => row.item.id)).toEqual(["later", "earlier", "unknown"]);
	});
	it("keeps factual unknown dates separate from created timestamps", () => {
		const root = fixture();
		records(root, [record("a")]);
		const data = view(root);
		expect(data.rows[0].item.event_time).toBeNull();
		expect(data.rows[0].item.created_at).toBe("2026-09-01T00:00:00Z");
		expect(render.renderMemoryPage(data)).toContain("事实日期：未知");
	});
	it("never labels a partial malformed snapshot effective", () => {
		const root = fixture();
		records(root, [record("a")]);
		put(root, "skills/file-memory/namespaces/work/broken.jsonl", "{invalid-json\n");
		const data = view(root, "status=all");
		expect(data.complete).toBe(false);
		expect(data.counts).toEqual({ all: 1, effective: 0, historical: 0, uncertain: 1 });
		expect(data.diagnostics.join(" ")).toContain("已跳过");
	});
	it("preserves incomplete metadata for inspection without inventing facts", () => {
		const root = fixture();
		records(root, [
			record("a", { sources: [], kind: "invalid", confidence: 2, event_time: "2026-02-30", created_at: "nonsense" }),
		]);
		const row = view(root, "status=uncertain").rows[0];
		expect(row.effective).toBe("uncertain");
		expect(row.item).toMatchObject({ kind: null, confidence: null, event_time: null, created_at: "" });
		expect(row.diagnostics.length).toBeGreaterThan(3);
	});
	it("handles missing predecessor and cycles without recursion or false effective status", () => {
		const root = fixture();
		records(root, [
			record("a", { supersedes_id: "b" }),
			record("b", { supersedes_id: "a" }),
			record("c", { supersedes_id: "missing" }),
		]);
		const data = view(root, "status=all");
		expect(data.counts.uncertain).toBe(3);
		expect(view(root, `record=${data.rows[0].key}`).history).toHaveLength(2);
		expect(data.rows[2].diagnostics.join(" ")).toContain("缺失前驱");
	});
	it("preserves duplicate IDs separately and reports uncertainty", () => {
		const root = fixture();
		records(root, [record("same"), record("same", { namespace: "work/example" })]);
		const data = view(root, "status=all");
		expect(data.complete).toBe(false);
		expect(data.rows).toHaveLength(2);
		expect(new Set(data.rows.map((row) => row.key)).size).toBe(2);
		expect(view(root, `record=${data.rows[0].key}`).history).toHaveLength(2);
	});
	it("bounds history traversal", () => {
		const root = fixture();
		records(
			root,
			Array.from({ length: 220 }, (_, i) => record(`chain-${i}`, i ? { supersedes_id: `chain-${i - 1}` } : {}))
		);
		const data = view(root);
		const history = view(root, `record=${data.rows[0].key}`);
		expect(history.history).toHaveLength(200);
		expect(history.historyDiagnostics.join(" ")).toContain("截断");
	});
	it("supports the intentional memory-root symlink but refuses links beneath it", () => {
		const root = fixture();
		records(root, [record("a")]);
		renameSync(join(root, "skills/file-memory"), join(root, "canonical-memory"));
		symlinkSync(join(root, "canonical-memory"), join(root, "skills/file-memory"));
		expect(view(root).counts.effective).toBe(1);
		put(root, "outside/secret.jsonl", JSON.stringify(record("SECRET")));
		symlinkSync(join(root, "outside/secret.jsonl"), join(root, "canonical-memory/namespaces/project/linked.jsonl"));
		const data = view(root, "status=all");
		expect(JSON.stringify(data)).not.toContain("SECRET");
		expect(data.complete).toBe(false);
		expect(data.diagnostics.join(" ")).toContain("已拒绝符号链接");
	});
	it("renders missing sources explicitly rather than claiming an empty healthy memory store", () => {
		const root = fixture();
		rmSync(join(root, "skills/file-memory"), { recursive: true });
		const data = view(root);
		expect(data.complete).toBe(false);
		expect(data.diagnostics.length).toBeGreaterThan(0);
	});
	it.each([
		"page=0",
		"page=1.2",
		"page=Infinity",
		"size=10000",
		"view=../auth.json",
		"doc=../../auth.json",
		"record=../../auth.json",
		"q=a&q=b",
		"file=/etc/passwd",
		"kind=unknown",
		`q=${"a".repeat(301)}`,
	])("rejects invalid bounded query %s", (query) => {
		expect(() => parseMemoryQuery(new URLSearchParams(query))).toThrow(MemoryQueryError);
	});
	it("only looks up document IDs from an explicit fixed catalog", () => {
		const root = fixture();
		expect(() => view(root, `view=archives&doc=${"a".repeat(24)}`)).toThrow(MemoryQueryError);
		expect(() => view(root, "namespace=../../secret")).not.toThrow();
		expect(view(root, "namespace=../../secret").rows).toHaveLength(0);
	});
	it("separates Core, global/workspace Agent rules, system operations and inactive archives", () => {
		const root = fixture();
		put(root, "skills/file-memory/core.md", "ONLY CORE");
		put(root, "agent/AGENTS.md", "ONLY GLOBAL RULES");
		put(root, "AGENTS.md", "ONLY WORKSPACE RULES");
		put(root, "SYSTEM.md", "ONLY OPERATIONS");
		put(root, "MEMORY.md", "ONLY OLD GLOBAL");
		put(root, "iMessage;+;demo/MEMORY.md", "ONLY OLD CHAT");
		put(root, "scratch/unrelated/MEMORY.md", "DO NOT SHOW");
		put(root, "auth.json", "DO NOT SHOW SECRET");
		expect(view(root, "view=core").documents[0].content).toBe("ONLY CORE");
		const agents = view(root, "view=agents");
		expect(agents.documents).toHaveLength(2);
		expect(agents.documents[0].content).toBe("ONLY GLOBAL RULES");
		expect(view(root, `view=agents&doc=${agents.documents[1].id}`).documents[1].content).toBe("ONLY WORKSPACE RULES");
		expect(view(root, "view=system").documents[0].content).toBe("ONLY OPERATIONS");
		const archives = view(root, "view=archives");
		expect(archives.documents).toHaveLength(2);
		expect(archives.documents[0].content).toBe("ONLY OLD GLOBAL");
		expect(view(root, `view=archives&doc=${archives.documents[1].id}`).documents[1].content).toBe("ONLY OLD CHAT");
		expect(render.renderMemoryPage(archives)).toContain("已停用");
		expect(JSON.stringify(archives)).not.toContain("DO NOT SHOW");
	});
	it("refuses linked document files and does not read arbitrary source paths", () => {
		const root = fixture();
		put(root, "secret.txt", "UNRELATED CONTENT");
		symlinkSync(join(root, "secret.txt"), join(root, "SYSTEM.md"));
		const data = view(root, "view=system");
		expect(data.documents[0].diagnostic).toContain("不安全");
		expect(JSON.stringify(data)).not.toContain("UNRELATED CONTENT");
		records(root, [
			record("source", { sources: [{ type: "test", label: "reference", path: join(root, "secret.txt") }] }),
		]);
		expect(JSON.stringify(view(root))).not.toContain("UNRELATED CONTENT");
	});
	it("escapes stored source text and filter values, with only local generated links", () => {
		const root = fixture();
		const attack = '<img src=x onerror="alert(1)"><script>BAD()</script>';
		records(root, [
			record("x", {
				text: attack,
				subjects: [attack],
				sources: [{ type: "test", label: attack, path: "javascript:BAD()" }],
			}),
		]);
		const html = render.renderMemoryPage(view(root));
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain("&lt;img");
		put(root, "AGENTS.md", attack);
		const docs = view(root, "view=agents");
		expect(render.renderMemoryPage(view(root, `view=agents&doc=${docs.documents[1].id}`))).not.toContain("<script>");
		const filtered = render.renderMemoryPage(view(root, `q=${encodeURIComponent(attack)}`));
		expect(filtered).not.toContain("<img");
	});
	it("serves actual HTML/JSON read-only routes and preserves source bytes", async () => {
		const root = fixture();
		records(root, [record("a")]);
		const path = join(root, "skills/file-memory/namespaces/project/demo.jsonl");
		const before = readFileSync(path);
		const server = createServer((req, res) => {
			if (!handleMemoryRequest(req, res, root, join(root, "agent"))) {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No port");
			const base = `http://127.0.0.1:${address.port}`;
			const html = await fetch(`${base}/memory`);
			expect(html.status).toBe(200);
			expect(html.headers.get("cache-control")).toBe("no-store");
			expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
			const body = await html.text();
			for (const link of ["/tasks", "/sources", "/scheduled"]) expect(body).toContain(`href="${link}"`);
			expect(body).toContain('name="viewport"');
			expect(await (await fetch(`${base}/memory/data`)).json()).toMatchObject({ counts: { effective: 1 } });
			expect((await fetch(`${base}/memory/data`, { method: "POST", body: "{}" })).status).toBe(405);
			expect((await fetch(`${base}/memory/unknown`)).status).toBe(404);
			expect((await fetch(`${base}/memory?doc=../secret`)).status).toBe(400);
			expect(readFileSync(path)).toEqual(before);
			vi.spyOn(render, "renderMemoryPage").mockImplementationOnce(() => {
				throw new Error("PRIVATE rendering error");
			});
			const failure = await fetch(`${base}/memory`);
			expect(failure.status).toBe(500);
			expect(await failure.text()).not.toContain("PRIVATE");
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
