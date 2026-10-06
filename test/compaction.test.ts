import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { compactionReply } from "../src/agent/commands.ts";
import { DirectSends } from "../src/agent/direct-send.ts";
import { ScheduledOutbox, Schedules } from "../src/agent/scheduling.ts";
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

		// #33 / ADR 0032 / ADR 0035: business-neutral workspace schedules, deadlines and the outbox.
		const scheduledDir = join(directory, "scheduled");
		const fixture = join(scheduledDir, "extensions/fixture");
		const hiddenFixture = join(scheduledDir, "extensions/.fixture");
		await mkdir(fixture, { recursive: true });
		await writeFile(
			join(scheduledDir, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
		);
		const fixtureSource = `
module.exports = ({ config, defineDoc, defineTask, defineExtension, ScheduledOutbox }) => {
 const version = "v1";
 const Effects = defineDoc({ kind: "fixture.effects", version: 1, scope: "session", initial: () => ({ values: [] }) });
 const task = name => defineTask({ name, version: 1, initial: () => ({ phase: "work" }), phases: {
  async work(record, runtime, context) {
   if (config.pauseUntil) await runtime.sleep(config.pauseUntil, context);
   await runtime.commit(async tx => {
    (await tx.doc(Effects)).values.push(version + ":" + record.input.jobId);
    const { chatGuid, jobId, date } = record.input;
    const requestId = chatGuid ? "fixture:" + jobId + ":" + date : undefined;
    if (requestId) (await tx.doc(ScheduledOutbox)).items.push({ chatGuid, requestId, text: version });
    return { status: "terminal", outcome: { status: "completed", result: { summary: version, ...(requestId ? { requestId } : {}), finishedAt: runtime.now() } } };
   }, context);
  }
 }, async abort(record, runtime, context) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); } });
 const first = task("fixture.first"), second = task("fixture.second");
 return { ...defineExtension({ name: "fixture", tasks: [first, second] }), schedules: [
  { id: "fixture-daily", name: "Daily fixture", enabled: config.enabled !== false, time: config.time, chatGuid: config.chatGuid, task: first.definition.name },
  ...(config.intervalMs ? [{ id: "fixture-interval", name: "Interval fixture", enabled: true, intervalMs: config.intervalMs, task: second.definition.name, async initialize() { if (config.invalid) throw new Error("fixture initializer failed"); } }] : [])
 ] };
};`;
		await writeFile(join(fixture, "index.ts"), fixtureSource);
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({ time: "07:45", chatGuid: "fixture-chat" }),
		);
		const effects = defineDoc<{ values: string[] }>({
			kind: "fixture.effects",
			version: 1,
			scope: "session",
			initial: () => ({ values: [] }),
		});
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
		const calls = faux.state.callCount;
		agent = await startService(scheduledOptions);
		const jobs = (await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT))?.items;
		const daily = jobs?.find((job) => job.id === "fixture-daily");
		const compact = jobs?.find((job) => job.kind === "compaction");
		if (!daily || !compact) throw new Error("Missing native jobs");
		const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
		expect(daily.timezone).toBe(timezone);
		expect(compact.timezone).toBe(timezone);
		const deadline = await agent.harness.getTask(daily.taskId, BACKGROUND_CONTEXT);
		expect(deadline).toMatchObject({
			background: true,
			state: { checkpoint: { phase: "sleep", at: Date.parse("2026-10-07T07:45:00") } },
		});

		// Old timezone metadata is refreshed without replacing the saved absolute deadline.
		await agent.harness.commit(async (tx) => {
			const job = (await tx.doc(Schedules)).items.find((item) => item.id === daily.id);
			if (job) job.timezone = "Pacific/Honolulu";
		}, BACKGROUND_CONTEXT);
		await agent.close();
		const manualRun = { jobId: "compact-chats", requestId: "fixture-manual-once" };
		agent = await startService({ ...scheduledOptions, runScheduled: manualRun });
		expect(await agent.harness.getTask(daily.taskId, BACKGROUND_CONTEXT)).toEqual(deadline);
		expect((await readSchedules(agent.harness)).jobs.find((job) => job.id === daily.id)?.timezone).toBe(
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

		// An admitted occurrence pauses; restart without its code fails instead of disabling the work.
		now = Date.parse("2026-10-07T07:46:00");
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({ time: "07:45", chatGuid: "fixture-chat", pauseUntil: now + 300 }),
		);
		agent = await startService(scheduledOptions);
		agent.harness.resume();
		const pausedHarness = agent.harness;
		await vi.waitFor(async () =>
			expect(
				(await pausedHarness.inspect(BACKGROUND_CONTEXT)).tasks.some(
					({ record }) => record.kind === "fixture.first",
				),
			).toBe(true),
		);
		await agent.close();
		// A hidden directory is not scanned.
		await rename(fixture, hiddenFixture);
		await expect(startService(scheduledOptions)).rejects.toThrow(
			"Missing definition or migration for unfinished task: fixture.first",
		);
		await rename(hiddenFixture, fixture);
		now += 300;
		agent = await startService(scheduledOptions);
		agent.harness.resume();
		const resumedHarness = agent.harness;
		await vi.waitFor(
			async () =>
				expect(
					(await readSchedules(resumedHarness)).jobs.find((job) => job.id === daily.id)?.runs[0],
				).toMatchObject({ status: "completed", result: { summary: "v1" } }),
			{ timeout: 5000 },
		);
		expect((await agent.harness.snapshot(ScheduledOutbox, BACKGROUND_CONTEXT))?.items).toHaveLength(1);
		send.mockClear();
		await agent.deliver();
		await agent.deliver();
		expect(send.mock.calls).toEqual([["fixture-chat", "v1"]]);
		let view = await readSchedules(agent.harness);
		expect(view.jobs.find((job) => job.id === daily.id)?.runs[0].delivery).toBe("sent");

		// An interrupted receipt is not replayed, even when its outbox item remains.
		await agent.harness.commit(async (tx) => {
			(await tx.doc(DirectSends)).requests[0].textStatus = "sending";
			(await tx.doc(ScheduledOutbox)).items.push({
				chatGuid: "fixture-chat",
				requestId: `fixture:${daily.id}:2026-10-07`,
				text: "v1",
			});
		}, BACKGROUND_CONTEXT);
		await agent.close();
		agent = await startService(scheduledOptions);
		await agent.deliver();
		expect(send).toHaveBeenCalledTimes(1);
		view = await readSchedules(agent.harness);
		expect(view.jobs.find((job) => job.id === daily.id)?.runs[0].delivery).toBe("unknown");
		await agent.close();

		// Missing multiple days before today's slot waits; no historical occurrence is admitted.
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({ time: "07:45", chatGuid: "fixture-chat" }),
		);
		now = Date.parse("2026-10-10T07:40:00");
		agent = await startService(scheduledOptions);
		agent.harness.resume();
		await vi.waitFor(
			async () =>
				expect(await agent?.harness.getTask(daily.taskId, BACKGROUND_CONTEXT)).toMatchObject({
					state: { checkpoint: { phase: "sleep", at: Date.parse("2026-10-10T07:45:00") } },
				}),
			{ timeout: 5000 },
		);
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
		expect((await agent.harness.snapshot(effects, BACKGROUND_CONTEXT))?.values).toEqual(["v1:fixture-daily"]);
		await agent.close();
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "07:45", enabled: false }));
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
		expect(send).toHaveBeenCalledTimes(1); // Maintenance remains quiet.
		await agent.harness.abortTask(compact.taskId, BACKGROUND_CONTEXT);
		await agent.harness.waitForTask(compact.taskId, BACKGROUND_CONTEXT);
		await agent.close();
		agent = await startService(scheduledOptions);
		expect((await readSchedules(agent.harness)).jobs.find((job) => job.kind === "compaction")?.status).toBe(
			"aborted",
		);

		// #33 / ADR 0035: multi-task schedules reload, roll back and remove safely.
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "23:59", intervalMs: 100 }));
		await agent.command({ chatGuid: "control", guid: "add-interval", text: "/reload" });
		const fixtureJobs = (await readSchedules(agent.harness)).jobs.filter((job) =>
			job.id.startsWith("fixture-"),
		);
		expect(fixtureJobs).toHaveLength(2);
		const savedTasks = await Promise.all(
			fixtureJobs.map((job) => agent?.harness.getTask(job.taskId, BACKGROUND_CONTEXT)),
		);
		await writeFile(join(fixture, "index.ts"), fixtureSource.replace('"v1"', '"v2"'));
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "22:59", intervalMs: 100 }));
		await agent.command({ chatGuid: "control", guid: "update-fixture", text: "/reload" });
		expect(
			await Promise.all(fixtureJobs.map((job) => agent?.harness.getTask(job.taskId, BACKGROUND_CONTEXT))),
		).toEqual(savedTasks);
		const definitions = await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT);
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({ time: "21:59", intervalMs: 100, invalid: true }),
		);
		await expect(
			agent.command({ chatGuid: "control", guid: "bad-fixture", text: "/reload" }),
		).rejects.toThrow("initializer failed");
		expect(await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT)).toEqual(definitions);
		await writeFile(join(fixture, "index.ts"), fixtureSource.replace('"fixture.second"', '"fixture.first"'));
		await expect(
			agent.command({ chatGuid: "control", guid: "duplicate-tasks", text: "/reload" }),
		).rejects.toThrow("Duplicate workspace task");
		await writeFile(join(fixture, "index.ts"), fixtureSource.replace('"v1"', '"v2"'));
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "22:59", intervalMs: 100 }));
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
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({ time: "22:59", intervalMs: 100, pauseUntil: now + 300 }),
		);
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
		await rename(fixture, hiddenFixture);
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
		expect((await agent.harness.snapshot(effects, BACKGROUND_CONTEXT))?.values).toEqual([
			"v1:fixture-daily",
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
