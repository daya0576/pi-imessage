import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSkillCatalog, parseSystemNotes } from "../harness.js";
import { loadMemoryNamespaces } from "../memory.js";
import {
	emptyCheckpoint,
	msUntilLocalHour,
	parseReflectionProposal,
	readCheckpoint,
	runReflection,
	shouldCatchUpReflection,
} from "../reflection.js";
import type { Message } from "../store.js";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "pi-reflection-"));
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

const emptyFeed = `<?xml version="1.0"?><rss><channel></channel></rss>`;

describe("reflection scheduling helpers", () => {
	it("computes delay until the next local hour", () => {
		const now = new Date(2026, 7, 9, 10, 15, 0);
		expect(msUntilLocalHour(11, now)).toBe(45 * 60_000);
		expect(msUntilLocalHour(10, now)).toBeGreaterThan(20 * 60 * 60_000);
	});

	it("catch-up only after today's scheduled hour if last run was earlier", () => {
		const now = new Date(2026, 7, 9, 15, 0, 0);
		const yesterday = new Date(2026, 7, 8, 20, 0, 0);
		const todayMorning = new Date(2026, 7, 9, 10, 0, 0);
		expect(shouldCatchUpReflection({ ...emptyCheckpoint(), lastRunAt: yesterday.toISOString() }, 3, now)).toBe(true);
		expect(shouldCatchUpReflection({ ...emptyCheckpoint(), lastRunAt: todayMorning.toISOString() }, 3, now)).toBe(
			false
		);
	});
});

describe("parseReflectionProposal", () => {
	it("reads fenced JSON", () => {
		const proposal = parseReflectionProposal(`\`\`\`json
{"summary":"ok","memories":[],"prompt_notes":[],"skills":[]}
\`\`\``);
		expect(proposal.summary).toBe("ok");
	});
});

describe("runReflection", () => {
	it("initializes a checkpoint when nothing is in the bootstrap window", async () => {
		const root = workspace();
		writeLog(root, "iMessage;-;+1", [{ date: "2026-07-01T00:00:00.000Z", text: "ancient" }]);
		let llmCalls = 0;
		const result = await runReflection(root, {
			now: new Date("2026-08-09T12:00:00.000Z"),
			fetchers: {
				fetchBlogFeed: async () => emptyFeed,
				fetchGithubEvents: async () => [],
			},
			llm: async () => {
				llmCalls += 1;
				return { summary: "should not run", memories: [], prompt_notes: [], skills: [] };
			},
		});
		expect(result.initialized).toBe(true);
		expect(llmCalls).toBe(0);
		expect(readCheckpoint(root).chats["iMessage;-;+1"]?.processedLines).toBe(1);
	});

	it("does not advance the checkpoint when the llm fails", async () => {
		const root = workspace();
		writeLog(root, "iMessage;-;+1", [{ date: "2026-08-09T10:00:00.000Z", text: "hello" }]);
		await runReflection(root, {
			now: new Date("2026-08-09T12:00:00.000Z"),
			fetchers: {
				fetchBlogFeed: async () => emptyFeed,
				fetchGithubEvents: async () => [],
			},
			llm: async () => {
				throw new Error("model down");
			},
		});
		expect(readCheckpoint(root).lastRunAt).toBeNull();
	});

	it("writes memory, a SYSTEM.md note, a skill, and a snapshot from mixed sources", async () => {
		const root = workspace();
		writeLog(root, "iMessage;-;+1", [{ date: "2026-08-09T10:00:00.000Z", text: "派派不能在雷雨天出门" }]);
		const result = await runReflection(root, {
			now: new Date("2026-08-09T12:00:00.000Z"),
			fetchers: {
				fetchBlogFeed: async () => `<?xml version="1.0"?>
<rss><channel>
<item>
  <title>派派成长日记</title>
  <guid>blog-1</guid>
  <pubDate>Sat, 08 Aug 2026 20:00:00 +0800</pubDate>
  <description>雷雨天不要出门</description>
</item>
</channel></rss>`,
				fetchGithubEvents: async () => [
					{
						id: "9",
						type: "PushEvent",
						created_at: "2026-08-09T08:00:00Z",
						repo: { name: "daya0576/pi-imessage" },
						payload: { ref: "refs/heads/main", commits: [{ message: "add reflection" }] },
					},
				],
			},
			llm: async (input) => {
				expect(input.items.some((item) => item.source === "chat")).toBe(true);
				expect(input.items.some((item) => item.source === "blog")).toBe(true);
				expect(input.items.some((item) => item.source === "github")).toBe(true);
				return {
					summary: "remember thunderstorm rule",
					memories: [
						{
							text: "雷雨天不要带派派出门",
							namespace: "health/paipai",
							kind: "preference",
							subjects: ["派派"],
							event_time: null,
							importance: 0.9,
							confidence: 1,
						},
					],
					prompt_notes: [
						{ action: "create", scope: "global", text: "Never suggest taking 派派 out in thunderstorms." },
					],
					skills: [
						{
							action: "create",
							name: "pudong-weather",
							scope: "global",
							description: "Pudong weather reminder",
							instructions: "Fetch weather and write a concrete reminder.",
						},
					],
				};
			},
		});

		expect(result.ok).toBe(true);
		expect(result.memoriesAdded).toBe(1);
		expect(result.notesChanged).toBe(1);
		expect(result.skillsChanged).toBe(1);
		expect(result.snapshotId).toMatch(/^snap_/);
		expect(loadMemoryNamespaces(root, ["health/paipai"]).map((item) => item.text)).toEqual(["雷雨天不要带派派出门"]);
		expect(parseSystemNotes(readFileSync(join(root, "SYSTEM.md"), "utf8")).map((note) => note.text)).toEqual([
			"Never suggest taking 派派 out in thunderstorms.",
		]);
		expect(listSkillCatalog(root).map((entry) => entry.name)).toEqual(["pudong-weather"]);
		expect(readCheckpoint(root).blog.seenGuids).toContain("blog-1");
		expect(readCheckpoint(root).github.seenIds).toContain("9");
	});
});
