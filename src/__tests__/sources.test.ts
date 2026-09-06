import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSources } from "../sources.js";
import { renderSourcesPage } from "../web/render.js";
import { handleSourcesRequest } from "../web/sources.js";

const directories: string[] = [];
const now = Date.parse("2026-09-06T07:00:00Z");
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "sources-test-"));
	directories.push(root);
	return root;
}
function put(root: string, name: string, value: unknown) {
	const path = join(root, name);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
function receipt(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		phase: "scheduled",
		state: "healthy",
		reason: null,
		checkedAt: "2026-09-06T06:59:00Z",
		lastSuccessAt: "2026-09-06T06:58:00Z",
		recordCount: 2,
		...overrides,
	};
}
afterEach(() => {
	for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("shows the full categorized catalog without claiming configured or healthy sources", () => {
	const root = fixture();
	const data = readSources(root, now);
	expect(data.categories).toHaveLength(10);
	expect(data.sources).toHaveLength(15);
	expect(data.sources.every((source) => source.state === "unknown" && source.phase === "not_configured")).toBe(true);
	put(root, "skills/immich/SKILL.md", "installed");
	expect(readSources(root, now).sources.find((source) => source.id === "immich")).toMatchObject({
		state: "unknown",
		phase: "query_only",
		lastSuccessAt: null,
	});
});

it("separates installed/login state from verified ingestion and expires old evidence", () => {
	const root = fixture();
	put(
		root,
		"sources/status/wechat.json",
		receipt({ phase: "installed", state: "blocked", reason: "screen_permission", lastSuccessAt: null })
	);
	expect(readSources(root, now).sources[0]).toMatchObject({
		phase: "installed",
		state: "blocked",
		lastSuccessAt: null,
	});
	put(root, "sources/status/wechat.json", receipt({ phase: "installed" }));
	expect(readSources(root, now).sources[0].state).toBe("unknown");
	put(root, "sources/status/wechat.json", receipt());
	expect(readSources(root, now).sources[0].state).toBe("healthy");
	expect(readSources(root, now + 3_600_000).sources[0].state).toBe("stale");
	put(root, "sources/status/wechat.json", receipt({ lastSuccessAt: "2099-01-01T00:00:00Z" }));
	expect(readSources(root, now).sources[0].state).toBe("unknown");
});

it("ignores secret-shaped extra fields and sanitizes malformed receipts without failing all sources", () => {
	const root = fixture();
	put(root, "sources/status/wechat.json", receipt({ token: "PRIVATE-TOKEN", rawError: "PRIVATE-BODY" }));
	expect(JSON.stringify(readSources(root, now))).not.toContain("PRIVATE");
	put(root, "sources/status/wechat.json", receipt({ state: "PRIVATE-TOKEN" }));
	const data = readSources(root, now);
	expect(data.sources[0]).toMatchObject({ state: "failed", reason: "sync_error", lastSuccessAt: null });
	expect(data.sources[1].state).toBe("unknown");
	expect(JSON.stringify(data)).not.toContain("PRIVATE");
});

it("bridges blog checkpoints, handles Shanghai timestamps and never exposes article URLs", () => {
	const root = fixture();
	put(root, "skills/blog-memory-updater/state-v2.json", {
		version: 2,
		processed_urls: ["https://PRIVATE-ARTICLE"],
		last_check: "2026-09-06T14:30:00",
		last_failures: [],
	});
	const data = readSources(root, now);
	expect(data.sources.find((source) => source.id === "blog")).toMatchObject({
		phase: "scheduled",
		state: "healthy",
		lastSuccessAt: "2026-09-06T06:30:00.000Z",
		recordCount: 1,
	});
	expect(JSON.stringify(data)).not.toContain("PRIVATE-ARTICLE");
});

it("uses source-specific checkpoint evidence without treating the common reflection timestamp as mail success", () => {
	const root = fixture();
	put(root, "sources/reflection-bridge.json", { chatDirectory: "iMessage;-;+10000000000" });
	put(root, "iMessage;-;+10000000000/scratch/memory-reflection/checkpoint.json", {
		version: 2,
		updatedAt: "2026-09-06T06:00:00Z",
		sources: { messagesDbRowId: 123 },
		offsets: { "PRIVATE-CHAT": 42 },
	});
	const data = readSources(root, now);
	expect(data.sources.find((source) => source.id === "messages")?.state).toBe("healthy");
	expect(data.sources.find((source) => source.id === "mail")?.lastSuccessAt).toBe(null);
	expect(JSON.stringify(data)).not.toContain("PRIVATE-CHAT");
	put(root, "sources/reflection-bridge.json", { chatDirectory: "../../private" });
	expect(readSources(root, now).sources.find((source) => source.id === "messages")?.state).toBe("unknown");
});

it("renders source rows safely with category links and the Sources tab on all pages", () => {
	const data = readSources(fixture(), now);
	data.sources[0].name = '<script>alert("xss")</script>';
	const html = renderSourcesPage(data);
	expect(html).toContain("外部数据源");
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain('<script>alert("xss")</script>');
	for (const page of ["page", "logs", "memory", "scheduled", "tasks"]) {
		expect(readFileSync(new URL(`../web/templates/${page}.eta`, import.meta.url), "utf8")).toContain('href="/sources"');
	}
});

it("serves no-store read-only routes, rejects writes and does not expose arbitrary paths", async () => {
	const root = fixture();
	const server = createServer((request, response) => {
		if (!handleSourcesRequest(request, response, root)) {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	const base = `http://127.0.0.1:${address.port}`;
	try {
		const response = await fetch(`${base}/sources`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain("外部数据源");
		expect((await fetch(`${base}/sources/data`)).status).toBe(200);
		expect((await fetch(`${base}/sources/wechat/run`, { method: "POST" })).status).toBe(405);
		expect((await fetch(`${base}/sources/secret`)).status).toBe(404);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
