import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { compactionReply } from "../src/agent/commands.ts";
import { DirectSends } from "../src/agent/direct-send.ts";
import { applyEnglish, parseEnglishAnswer, planEnglish, readLearningHistory } from "../src/agent/english.ts";
import { EnglishLearning, ScheduledOutbox, Schedules } from "../src/agent/scheduling.ts";
import { startService } from "../src/main.ts";
import { readSchedules } from "../src/web/schedules.ts";

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
		settings.scheduledEnglish.enabled = false;
		await writeFile(join(scheduledDir, "settings.json"), JSON.stringify(settings));
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
	} finally {
		await agent?.close();
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
