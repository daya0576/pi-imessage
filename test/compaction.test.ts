import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import type {
	EnglishFunctions,
	LearningHistory,
	LearningPolicy,
} from "../examples/workspace-extensions/workplace-english/learning.ts";
import { compactionReply } from "../src/agent/commands.ts";
import { DirectSends } from "../src/agent/direct-send.ts";
import { ScheduledOutbox, Schedules } from "../src/agent/scheduling.ts";
import { startService } from "../src/main.ts";
import { readSchedules } from "../src/web/schedules.ts";

const learning = createRequire(import.meta.url)(
	"../examples/workspace-extensions/workplace-english/learning.ts",
) as EnglishFunctions;
const policy: LearningPolicy = {
	reviewIntervals: [1, 3, 7, 14, 30],
	effectiveFrom: "2026-10-04",
	maxReviews: 2,
	dailyLimit: 3,
	windowDays: 30,
	maxNew: 10,
	minNewGapDays: 3,
};
const { applyEnglish, parseEnglishAnswer } = learning;
const planEnglish = (history: LearningHistory, date: string) => learning.planEnglish(history, date, policy);
const readLearningHistory = (path: string) => learning.readLearningHistory(path, policy);
const EnglishLearning = defineDoc<{
	history?: LearningHistory;
	cards: Record<string, { text: string; requestId: string }>;
}>({
	kind: "imessage.english-learning",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cards: {} }),
});

// #33: host scheduling stays quiet, native no-ops do not infer, and admission failures preserve context.
it("schedules quiet native compaction, skips empty/reset chats and preserves context on failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-compact-"));
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	try {
		// #33 / ADR 0034: timezone and DST checks run outside the test worker.
		for (const timezone of ["UTC", "America/New_York"])
			await promisify(execFile)(
				process.execPath,
				["--experimental-strip-types", fileURLToPath(new URL("fixtures/local-time.ts", import.meta.url))],
				{ env: { ...process.env, TZ: timezone }, timeout: 10000 },
			);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const send = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		agent = await startService({
			workingDir: directory,
			agentDir: join(directory, "agent"),
			runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
			extensions: () => [],
			send,
			sendAttachment: vi.fn(),
		});
		expect(await agent.compact()).toEqual([]);
		faux.setResponses([fauxAssistantMessage("Short answer")]);
		const record = await (
			await agent.submit({ chatGuid: "chat", guid: "question", text: "Short question" })
		).wait(BACKGROUND_CONTEXT);
		const conversation = await agent.harness.conversation(record.conversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error("Missing conversation");
		const before = await conversation.context(BACKGROUND_CONTEXT);
		const tasks = await agent.compact();
		expect(tasks).toHaveLength(1);
		await agent.harness.waitForTask(tasks[0], BACKGROUND_CONTEXT);
		expect(faux.state.callCount).toBe(1);
		expect(await conversation.context(BACKGROUND_CONTEXT)).toEqual(before);
		expect(send).not.toHaveBeenCalled();
		vi.spyOn(agent.harness, "conversation").mockResolvedValueOnce(conversation);
		vi.spyOn(conversation, "compact").mockRejectedValueOnce(new Error("fixture admission failure"));
		expect(await agent.compact()).toEqual([]);
		expect(warn).toHaveBeenCalledWith("Scheduled compaction admission failed", "chat", expect.any(Error));
		expect(await conversation.context(BACKGROUND_CONTEXT)).toEqual(before);
		// #33: manual no-op reports no work, rather than claiming a summary was applied.
		await agent.command({ chatGuid: "chat", guid: "compact-command", text: "/compact" });
		await vi.waitFor(() => expect(send.mock.calls.map(([, text]) => text)).toEqual(["Nothing to compact."]), {
			timeout: 5000,
		});
		expect(faux.state.callCount).toBe(1);
		// Public receipt fixtures test our reporting, not Durable's summarization/placement guarantees.
		expect(compactionReply({ status: "failed", error: { message: "fixture failure" } })).toBe(
			"Compaction failed.",
		);
		expect(compactionReply({ status: "aborted" })).toBe("Compaction cancelled.");
		if (record.status !== "done" || record.type !== "input") throw new Error("Missing answer");
		expect(compactionReply({ status: "completed", result: { entryId: record.answer } })).toBe("Compacted.");
		const completed = { status: "completed", result: { submissionId: record.id } } as const;
		const placement = { id: record.id, conversationId: record.conversationId, type: "write" } as const;
		expect(compactionReply(completed, { ...placement, status: "done", entry: record.answer })).toBe(
			"Compacted.",
		);
		expect(compactionReply(completed, { ...placement, status: "queued" })).toBe(
			"Compaction summary queued for the next turn boundary.",
		);
		expect(compactionReply(completed, { ...placement, status: "unanswered", reason: "stale" })).toBe(
			"Compaction summary discarded because the context changed.",
		);
		expect(compactionReply(completed, { ...placement, status: "unanswered", reason: "aborted" })).toBe(
			"Compaction summary was not applied.",
		);
		expect(compactionReply(completed)).toBe("Compaction result unavailable.");
		await conversation.reset(undefined, BACKGROUND_CONTEXT);
		expect(await agent.compact()).toEqual([]);
		await agent.close();

		// #33 / ADR 0032: native deadlines, learning and the outbox survive reopening.
		const scheduledDir = join(directory, "scheduled");
		await mkdir(scheduledDir);
		const source = join(scheduledDir, "used.json");
		const original = JSON.stringify({
			entries: [
				{
					date: "2026-10-06",
					expressions: ["One", "Two", "Three", "Four"],
					paragraph: "One Two Three Four. Original paragraph.",
				},
			],
			reviews: {},
			extra: { retained: true },
		});
		await writeFile(source, original);
		const settings = {
			chatAllowlist: { whitelist: ["*"], blacklist: [] },
			scheduledEnglish: {
				enabled: true,
				chatGuid: "english-chat",
				time: "07:45",
				historyFile: source,
			},
		};
		await writeFile(join(scheduledDir, "settings.json"), JSON.stringify(settings));
		// Offline migration touches configuration only; the legacy file remains compatible and unchanged.
		await promisify(execFile)(
			process.execPath,
			["ops/migrate-workspace-extensions.mjs", "--apply", scheduledDir],
			{ timeout: 10000 },
		);
		const configPath = join(scheduledDir, "extensions/workplace-english/config.json");
		const config = JSON.parse(await readFile(configPath, "utf8"));
		expect(config.policy).toEqual(policy);
		const migratedSettings = await readFile(join(scheduledDir, "settings.json"), "utf8");
		expect(JSON.parse(migratedSettings).scheduledEnglish).toEqual(settings.scheduledEnglish);
		await promisify(execFile)(
			process.execPath,
			["ops/migrate-workspace-extensions.mjs", "--apply", scheduledDir],
			{ timeout: 10000 },
		);
		expect(await readFile(join(scheduledDir, "settings.json"), "utf8")).toBe(migratedSettings);
		let now = Date.parse("2026-10-07T07:40:00");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const scheduledOptions = {
			workingDir: scheduledDir,
			agentDir: join(scheduledDir, "agent"),
			runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
			extensions: () => [],
			send,
			sendAttachment: vi.fn(),
		};
		agent = await startService(scheduledOptions);
		const jobs = (await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT))?.items;
		const english = jobs?.find((job) => job.kind === "english");
		const compact = jobs?.find((job) => job.kind === "compaction");
		if (!english || !compact) throw new Error("Missing native jobs");
		const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
		expect(english.timezone).toBe(timezone);
		expect(compact.timezone).toBe(timezone);
		const deadline = await agent.harness.getTask(english.taskId, BACKGROUND_CONTEXT);
		expect(deadline).toMatchObject({
			background: true,
			state: { checkpoint: { phase: "sleep", at: Date.parse("2026-10-07T07:45:00") } },
		});
		const imported = (
			await agent.harness.snapshot(EnglishLearning, english.conversationId, BACKGROUND_CONTEXT)
		)?.history;
		if (!imported) throw new Error("Missing learning history");
		expect(imported.extra).toEqual({ retained: true });
		const plan = planEnglish(imported, "2026-10-07");
		expect(plan.reviews.map((review) => review.expression)).toEqual(["One", "Two"]);
		expect(plan.newExpression).toBe(false);
		expect(() => parseEnglishAnswer(JSON.stringify({ reviews: [], newExpression: null }), plan)).toThrow();
		const reviewAnswer = {
			reviews: plan.reviews.map((review) => ({ expression: review.expression, meaning: "复习释义" })),
			newExpression: null,
		};
		const copy = structuredClone(imported);
		const card = applyEnglish(copy, plan, reviewAnswer);
		expect(card.split("Original paragraph.")).toHaveLength(2); // Printed exactly once for the source card.
		expect(copy.reviews["2026-10-06|four"]).toBeUndefined(); // Unshown expressions are not completed.
		expect(copy.reviews["2026-10-06|one"].completedDays).toEqual([1]);
		const newPlan = planEnglish({ entries: [], reviews: {} }, "2026-10-07");
		const newAnswer = parseEnglishAnswer(
			JSON.stringify({
				reviews: [],
				newExpression: {
					expression: "Let's align on this.",
					meaning: "我们对齐一下",
					paragraph: "Let's align on this. What do you need from me?",
				},
			}),
			newPlan,
		);
		const newHistory = { entries: [], reviews: {} };
		applyEnglish(newHistory, newPlan, newAnswer);
		expect(planEnglish(newHistory, "2026-10-08").newExpression).toBe(false);
		const quota = {
			entries: Array.from({ length: 10 }, (_, index) => ({
				date: "2026-10-04",
				expressions: [`Expression ${index}`],
				paragraph: "Original.",
			})),
			reviews: {},
		};
		expect(planEnglish(quota, "2026-10-08").newExpression).toBe(false);

		// Old timezone metadata is refreshed without replacing the saved absolute deadline.
		await agent.harness.commit(async (tx) => {
			const job = (await tx.doc(Schedules)).items.find((item) => item.id === english.id);
			if (job) job.timezone = "Pacific/Honolulu";
		}, BACKGROUND_CONTEXT);
		await agent.close();
		const manualRun = { jobId: "compact-chats", requestId: "fixture-manual-once" };
		agent = await startService({ ...scheduledOptions, runScheduled: manualRun });
		expect(await agent.harness.getTask(english.taskId, BACKGROUND_CONTEXT)).toEqual(deadline);
		expect((await readSchedules(agent.harness)).jobs.find((job) => job.kind === "english")?.timezone).toBe(
			timezone,
		);
		agent.harness.resume();
		await vi.waitFor(
			async () => {
				if (!agent) throw new Error("Missing service");
				const maintenance = (await readSchedules(agent.harness)).jobs.find(
					(job) => job.kind === "compaction",
				);
				expect(maintenance?.runs[0].status).toBe("completed");
				expect(maintenance?.nextAt).toBe(Date.parse("2026-10-07T13:40:00"));
			},
			{ timeout: 5000 },
		);
		await agent.close();
		agent = await startService({ ...scheduledOptions, runScheduled: manualRun });
		expect(
			(await readSchedules(agent.harness)).jobs.find((job) => job.kind === "compaction")?.runs,
		).toHaveLength(1);
		await agent.close();
		now = Date.parse("2026-10-07T07:46:00");
		faux.setResponses([fauxAssistantMessage(JSON.stringify(reviewAnswer))]);
		agent = await startService(scheduledOptions);
		agent.harness.resume();
		await agent.harness.waitForIdle(BACKGROUND_CONTEXT); // Does not wait for the sleeping scheduler.
		await vi.waitFor(
			async () =>
				expect(
					(await agent?.harness.snapshot(EnglishLearning, english.conversationId, BACKGROUND_CONTEXT))?.cards[
						"2026-10-07"
					],
				).toBeDefined(),
			{ timeout: 5000 },
		);
		expect((await agent.harness.snapshot(ScheduledOutbox, BACKGROUND_CONTEXT))?.items).toHaveLength(1);
		expect(await readFile(source, "utf8")).toBe(original);
		const calls = faux.state.callCount;
		await agent.close();
		agent = await startService(scheduledOptions);
		expect(
			(await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT))?.items.find(
				(job) => job.kind === "english",
			)?.taskId,
		).toBe(english.taskId);
		// #33 / ADR 0035: migrate an admitted v1 checkpoint, retaining its ID and saved answer.
		const child = await agent.harness.commit(async (tx) => {
			const tasks = await tx.scanTasks(
				{ conversationId: english.conversationId, kind: "workplace-english.card" },
				10,
			);
			return (await tx.scanConversations({ ownerTaskId: tasks.items[0].id }, 10)).items[0];
		}, BACKGROUND_CONTEXT);
		if (!child) throw new Error("Missing saved generation child");
		const legacy = defineTask({
			name: "imessage.scheduled-execution",
			version: 1,
			initial: () => ({ phase: "english" as const, conversationId: child.id, plan }),
			phases: {
				async english() {
					throw new Error("Legacy business code must not execute");
				},
			},
			async abort(_task, runtime, context) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		});
		const legacyId = await agent.harness.commit(
			(tx) =>
				tx.createTask(
					legacy,
					{ jobId: english.id, date: "2026-10-07", dueAt: now, startedAt: now },
					{ conversationId: english.conversationId, ownership: { kind: "conversation" }, background: true },
				),
			BACKGROUND_CONTEXT,
		);
		await agent.close();
		const businessPath = join(scheduledDir, "extensions/workplace-english");
		// A hidden directory is not scanned; missing required code must fail explicitly, not disable work.
		await rename(businessPath, join(scheduledDir, "extensions/.workplace-english"));
		await expect(startService(scheduledOptions)).rejects.toThrow("Missing extension for unfinished schedule");
		await rename(join(scheduledDir, "extensions/.workplace-english"), businessPath);
		agent = await startService(scheduledOptions);
		expect((await agent.harness.waitForTask(legacyId, BACKGROUND_CONTEXT)).state.outcome.status).toBe(
			"completed",
		);
		expect((await agent.harness.getTask(legacyId, BACKGROUND_CONTEXT))?.version).toBe(2);
		expect(faux.state.callCount).toBe(calls);
		expect((await agent.harness.snapshot(ScheduledOutbox, BACKGROUND_CONTEXT))?.items).toHaveLength(1);
		send.mockClear();
		await agent.deliver();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]).toEqual(["english-chat", card]);
		await agent.deliver();
		expect(send).toHaveBeenCalledTimes(1);
		expect(faux.state.callCount).toBe(calls);
		let view = await readSchedules(agent.harness);
		expect(view.jobs.find((job) => job.kind === "english")?.runs[0].delivery).toBe("sent");

		// An interrupted receipt is not replayed, even when its outbox item remains.
		await agent.harness.commit(async (tx) => {
			(await tx.doc(DirectSends)).requests[0].textStatus = "sending";
			(await tx.doc(ScheduledOutbox)).items.push({
				chatGuid: "english-chat",
				requestId: `scheduled:${english.id}:2026-10-07`,
				text: card,
			});
		}, BACKGROUND_CONTEXT);
		await agent.close();
		agent = await startService(scheduledOptions);
		await agent.deliver();
		expect(send).toHaveBeenCalledTimes(1);
		view = await readSchedules(agent.harness);
		expect(view.jobs.find((job) => job.kind === "english")?.runs[0].delivery).toBe("unknown");
		await agent.close();

		// Missing multiple days before today's slot waits; no historical English card is generated.
		now = Date.parse("2026-10-10T07:40:00");
		agent = await startService(scheduledOptions);
		agent.harness.resume();
		await vi.waitFor(
			async () =>
				expect(await agent?.harness.getTask(english.taskId, BACKGROUND_CONTEXT)).toMatchObject({
					state: { checkpoint: { phase: "sleep", at: Date.parse("2026-10-10T07:45:00") } },
				}),
			{ timeout: 5000 },
		);
		expect(faux.state.callCount).toBe(calls);
		await vi.waitFor(
			async () => {
				if (!agent) throw new Error("Missing service");
				const maintenance = (await readSchedules(agent.harness)).jobs.find(
					(job) => job.kind === "compaction",
				);
				expect(maintenance?.phase).toBe("sleep");
				expect(maintenance?.runs[0].status).toBe("completed");
			},
			{ timeout: 5000 },
		);
		await agent.close();
		config.enabled = false;
		await writeFile(configPath, JSON.stringify(config));
		for (let index = 0; index < 12; index++) {
			now += 6 * 3600000;
			agent = await startService(scheduledOptions);
			agent.harness.resume();
			await vi.waitFor(
				async () => {
					if (!agent) throw new Error("Missing service");
					const current = await readSchedules(agent.harness);
					expect(current.jobs.find((job) => job.kind === "compaction")?.phase).toBe("sleep");
					expect(current.jobs.find((job) => job.kind === "compaction")?.runs[0]).toMatchObject({
						status: "completed",
						input: { startedAt: now },
					});
				},
				{ timeout: 5000 },
			);
			await agent.close();
		}
		agent = await startService(scheduledOptions);
		view = await readSchedules(agent.harness);
		expect(view.jobs.find((job) => job.kind === "compaction")?.runs).toHaveLength(10);
		expect(view.recent).toHaveLength(10);
		expect(view.recent.map((run) => run.id)).toEqual(view.recent.map((run) => run.id).sort((a, b) => b - a));
		expect(faux.state.callCount).toBe(calls);
		expect(send).toHaveBeenCalledTimes(1); // Maintenance remains quiet.
		await agent.harness.abortTask(compact.taskId, BACKGROUND_CONTEXT);
		await agent.harness.waitForTask(compact.taskId, BACKGROUND_CONTEXT);
		await agent.close();
		agent = await startService(scheduledOptions);
		expect((await readSchedules(agent.harness)).jobs.find((job) => job.kind === "compaction")?.status).toBe(
			"aborted",
		);
		await writeFile(source, "{broken");
		await expect(readLearningHistory(source)).rejects.toThrow();
		expect(
			(await agent.harness.snapshot(EnglishLearning, english.conversationId, BACKGROUND_CONTEXT))?.history
				?.extra,
		).toEqual({ retained: true });

		// #33 / ADR 0035: business-neutral multi-task schedules reload and remove safely.
		const fixture = join(scheduledDir, "extensions/fixture");
		await mkdir(fixture);
		const fixtureSource = `
module.exports = ({ config, defineDoc, defineTask, defineExtension }) => {
 const version = "v1";
 const Effects = defineDoc({ kind: "fixture.effects", version: 1, scope: "session", initial: () => ({ values: [] }) });
 const task = name => defineTask({ name, version: 1, initial: () => ({ phase: "work" }), phases: {
  async work(record, runtime, context) {
   if (config.pauseUntil) await runtime.sleep(config.pauseUntil, context);
   await runtime.commit(async tx => {
    (await tx.doc(Effects)).values.push(version + ":" + record.input.jobId);
    return { status: "terminal", outcome: { status: "completed", result: { summary: version, finishedAt: runtime.now() } } };
   }, context);
  }
 }, async abort(record, runtime, context) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); } });
 const first = task("fixture.first"), second = task("fixture.second");
 return { ...defineExtension({ name: "fixture", tasks: [first, second] }), schedules: [
  { id: "fixture-daily", name: "Daily fixture", enabled: true, time: config.time, task: first.definition.name },
  { id: "fixture-interval", name: "Interval fixture", enabled: true, intervalMs: 100, task: second.definition.name, async initialize() { if (config.invalid) throw new Error("fixture initializer failed"); } }
 ] };
};`;
		await writeFile(join(fixture, "index.ts"), fixtureSource);
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "23:59" }));
		await agent.command({ chatGuid: "control", guid: "add-fixture", text: "/reload" });
		const fixtureJobs = (await readSchedules(agent.harness)).jobs.filter((job) =>
			job.id.startsWith("fixture-"),
		);
		expect(fixtureJobs).toHaveLength(2);
		const savedTasks = await Promise.all(
			fixtureJobs.map((job) => agent?.harness.getTask(job.taskId, BACKGROUND_CONTEXT)),
		);
		await writeFile(join(fixture, "index.ts"), fixtureSource.replace('"v1"', '"v2"'));
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "22:59" }));
		await agent.command({ chatGuid: "control", guid: "update-fixture", text: "/reload" });
		expect(
			await Promise.all(fixtureJobs.map((job) => agent?.harness.getTask(job.taskId, BACKGROUND_CONTEXT))),
		).toEqual(savedTasks);
		const definitions = await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT);
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "21:59", invalid: true }));
		await expect(
			agent.command({ chatGuid: "control", guid: "bad-fixture", text: "/reload" }),
		).rejects.toThrow("initializer failed");
		expect(await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT)).toEqual(definitions);
		await writeFile(join(fixture, "index.ts"), fixtureSource.replace('"fixture.second"', '"fixture.first"'));
		await expect(
			agent.command({ chatGuid: "control", guid: "duplicate-tasks", text: "/reload" }),
		).rejects.toThrow("Duplicate workspace task");
		await writeFile(join(fixture, "index.ts"), fixtureSource.replace('"v1"', '"v2"'));
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "22:59" }));
		await agent.close();
		agent = await startService({
			...scheduledOptions,
			runScheduled: { jobId: "fixture-daily", requestId: "fixture-daily-once" },
		});
		agent.harness.resume();
		const dailyHarness = agent.harness;
		await vi.waitFor(
			async () =>
				expect(
					(await readSchedules(dailyHarness)).jobs.find((job) => job.id === "fixture-daily")?.runs[0],
				).toMatchObject({ status: "completed", result: { summary: "v2" } }),
			{ timeout: 5000 },
		);
		await agent.close();
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "22:59", pauseUntil: now + 300 }));
		agent = await startService({
			...scheduledOptions,
			runScheduled: { jobId: "fixture-interval", requestId: "fixture-interval-once" },
		});
		agent.harness.resume();
		const intervalHarness = agent.harness;
		await vi.waitFor(async () =>
			expect(
				(await intervalHarness.inspect(BACKGROUND_CONTEXT)).tasks.some(
					({ record }) => record.kind === "fixture.second",
				),
			).toBe(true),
		);
		// A deadline waking while the manual occurrence is paused joins it instead of overlapping.
		now += 100;
		const intervalJob = fixtureJobs.find((job) => job.id === "fixture-interval");
		if (!intervalJob) throw new Error("Missing interval fixture");
		await vi.waitFor(async () =>
			expect(await intervalHarness.getTask(intervalJob.taskId, BACKGROUND_CONTEXT)).toMatchObject({
				state: { checkpoint: { phase: "advance" } },
			}),
		);
		expect(
			(await readSchedules(intervalHarness)).jobs.find((job) => job.id === "fixture-interval")?.runs,
		).toHaveLength(1);
		await writeFile(join(fixture, "index.ts"), fixtureSource.replaceAll("version: 1", "version: 2"));
		await expect(
			agent.command({ chatGuid: "control", guid: "missing-migration", text: "/reload" }),
		).rejects.toThrow("migration for unfinished task");
		await writeFile(join(fixture, "index.ts"), fixtureSource);
		await rename(fixture, join(scheduledDir, "extensions/.fixture"));
		await agent.command({ chatGuid: "control", guid: "remove-fixture", text: "/reload" });
		expect(
			(await readSchedules(agent.harness)).jobs
				.filter((job) => job.id.startsWith("fixture-"))
				.every((job) => !job.enabled),
		).toBe(true);
		now += 300;
		await vi.waitFor(
			async () =>
				expect(
					(await readSchedules(intervalHarness)).jobs.find((job) => job.id === "fixture-interval")?.runs[0],
				).toMatchObject({ status: "completed", result: { summary: "v2" } }),
			{ timeout: 5000 },
		);
		const effects = defineDoc<{ values: string[] }>({
			kind: "fixture.effects",
			version: 1,
			scope: "session",
			initial: () => ({ values: [] }),
		});
		expect((await agent.harness.snapshot(effects, BACKGROUND_CONTEXT))?.values).toEqual([
			"v2:fixture-daily",
			"v2:fixture-interval",
		]);
		expect(faux.state.callCount).toBe(calls);
	} finally {
		await agent?.close();
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
