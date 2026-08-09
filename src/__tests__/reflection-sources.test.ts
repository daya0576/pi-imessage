import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectReflectionSources,
	emptySourceCheckpoints,
	parseRssOrAtomItems,
	summarizeGithubEvent,
} from "../reflection-sources.js";
import type { Message } from "../store.js";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "pi-sources-"));
}

function writeLog(root: string, chatGuid: string, messages: Array<Partial<Message>>): void {
	mkdirSync(join(root, chatGuid), { recursive: true });
	const lines = messages.map((message, index) =>
		JSON.stringify({
			date: message.date ?? `2026-08-09T0${index}:00:00.000Z`,
			sender: message.sender ?? "+1",
			text: message.text ?? "hi",
			attachments: [],
			fromAgent: message.fromAgent ?? false,
			messageType: message.messageType ?? "imessage",
		})
	);
	writeFileSync(join(root, chatGuid, "log.jsonl"), `${lines.join("\n")}\n`);
}

describe("parseRssOrAtomItems", () => {
	it("parses RSS items with guid and description", () => {
		const xml = `<?xml version="1.0"?>
<rss><channel>
<item>
  <title>派派成长日记</title>
  <link>https://changchen.me/blog/a/</link>
  <guid>https://changchen.me/blog/a/</guid>
  <pubDate>Sun, 19 Jul 2026 08:50:17 +0800</pubDate>
  <description><![CDATA[<p>hello world</p>]]></description>
</item>
</channel></rss>`;
		const items = parseRssOrAtomItems(xml);
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe("派派成长日记");
		expect(items[0]?.description).toContain("hello world");
	});
});

describe("summarizeGithubEvent", () => {
	it("summarizes push events with commit messages", () => {
		const item = summarizeGithubEvent({
			id: "1",
			type: "PushEvent",
			created_at: "2026-08-09T08:00:00Z",
			repo: { name: "daya0576/beaverhabits" },
			payload: {
				ref: "refs/heads/main",
				commits: [{ message: "fix landing" }, { message: "tweak copy" }],
			},
		});
		expect(item?.label).toContain("beaverhabits");
		expect(item?.text).toContain("fix landing");
	});
});

describe("collectReflectionSources", () => {
	it("collects chat, blog, and github increments with independent checkpoints", async () => {
		const root = workspace();
		const now = new Date("2026-08-09T12:00:00.000Z");
		writeLog(root, "iMessage;-;+1", [
			{ date: "2026-08-01T00:00:00.000Z", text: "old" },
			{ date: "2026-08-08T20:00:00.000Z", text: "recent chat" },
		]);

		const first = await collectReflectionSources({
			workingDir: root,
			checkpoint: emptySourceCheckpoints(),
			blogUrl: "https://example.test/atom.xml",
			githubUser: "daya0576",
			now,
			fetchers: {
				fetchBlogFeed: async () => `<?xml version="1.0"?>
<rss><channel>
<item>
  <title>Old post</title>
  <guid>old-post</guid>
  <pubDate>Mon, 01 Jun 2026 00:00:00 +0800</pubDate>
  <description>ancient</description>
</item>
<item>
  <title>New post</title>
  <guid>new-post</guid>
  <pubDate>Sat, 08 Aug 2026 20:00:00 +0800</pubDate>
  <description>fresh blog</description>
</item>
</channel></rss>`,
				fetchGithubEvents: async () => [
					{
						id: "100",
						type: "PushEvent",
						created_at: "2026-06-01T00:00:00Z",
						repo: { name: "daya0576/old" },
						payload: { ref: "refs/heads/main", commits: [{ message: "old" }] },
					},
					{
						id: "200",
						type: "PushEvent",
						created_at: "2026-08-09T08:00:00Z",
						repo: { name: "daya0576/beaverhabits" },
						payload: { ref: "refs/heads/main", commits: [{ message: "ship it" }] },
					},
				],
			},
		});

		expect(first.items.some((item) => item.text.includes("recent chat"))).toBe(true);
		expect(
			first.items
				.filter((item) => item.source === "blog")
				.map((item) => item.id)
				.sort()
		).toEqual(["new-post", "old-post"]);
		expect(first.items.some((item) => item.id === "200")).toBe(true);
		expect(first.next.blog.seenGuids).toEqual(expect.arrayContaining(["old-post", "new-post"]));
		expect(first.next.github.seenIds).toContain("100");
		expect(first.bootstrapped.blog).toBe(true);

		const second = await collectReflectionSources({
			workingDir: root,
			checkpoint: first.next,
			blogUrl: "https://example.test/atom.xml",
			githubUser: "daya0576",
			now: new Date("2026-08-09T13:00:00.000Z"),
			fetchers: {
				fetchBlogFeed: async () => `<?xml version="1.0"?>
<rss><channel>
<item><title>New post</title><guid>new-post</guid><pubDate>Sat, 08 Aug 2026 20:00:00 +0800</pubDate><description>fresh blog</description></item>
</channel></rss>`,
				fetchGithubEvents: async () => [
					{
						id: "200",
						type: "PushEvent",
						created_at: "2026-08-09T08:00:00Z",
						repo: { name: "daya0576/beaverhabits" },
						payload: { ref: "refs/heads/main", commits: [{ message: "ship it" }] },
					},
				],
			},
		});
		expect(second.items).toEqual([]);
	});
});
