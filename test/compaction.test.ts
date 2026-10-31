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
import { RunRequests, ScheduledOutbox, Schedules } from "../src/agent/scheduling.ts";
import { startService } from "../src/main.ts";
import { readSchedules } from "../src/web/schedules.ts";

// #33 / ADR 0054: the host reports native compaction and runs workspace schedules; it defines none of its own.
it("reports manual compaction and runs workspace schedules natively", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-compact-"));
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	try {
		// #33: timezone and DST checks run outside the test worker.
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
		agent = await startService({
			workingDir: directory,
			agentDir: join(directory, "agent"),
			runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
			extensions: () => [],
			send,
			sendAttachment: vi.fn(),
		});
		faux.setResponses([fauxAssistantMessage("Short answer")]);
		const record = await (
			await agent.submit({ chatGuid: "chat", guid: "question", text: "Short question" })
		).wait(BACKGROUND_CONTEXT);
		expect(send).not.toHaveBeenCalled();
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
		await agent.close();

		// #33: business-neutral workspace schedules, deadlines and the outbox.
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
 const Effects = defineDoc({ kind: "fixture.effects", version: 1, scope: "session", initial: () => ({ values: [] }), checkpointWhen: () => false });
 const task = name => defineTask({ name, version: 1, initial: () => ({ phase: "work" }), phases: {
  async work(record, runtime, context) {
   if (config.pauseUntil && runtime.now() < config.pauseUntil) return runtime.sleepUntil(config.pauseUntil, record.state.checkpoint, context);
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
  ...(config.intervalMs ? [{ id: "fixture-interval", name: "Interval fixture", enabled: true, intervalMs: config.intervalMs, task: second.definition.name, async initialize() { if (config.invalid) throw new Error("fixture initializer failed"); } }] : []),
  ...(config.maintenanceMs ? [{ id: "fixture-maintenance", name: "Maintenance fixture", enabled: true, intervalMs: config.maintenanceMs, task: first.definition.name }] : [])
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
			checkpointWhen: () => false,
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
		expect(jobs).toHaveLength(1); // ADR 0054: no framework job of its own.
		const daily = jobs?.find((job) => job.id === "fixture-daily");
		if (!daily) throw new Error("Missing native job");
		expect(daily.timezone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
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
		const runRequests = [{ id: "fixture-now", scheduleId: daily.id, at: "now" }];
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({ time: "07:45", chatGuid: "fixture-chat", runRequests }),
		);
		agent = await startService(scheduledOptions);
		expect(await agent.harness.getTask(daily.taskId, BACKGROUND_CONTEXT)).toMatchObject({
			state: deadline?.state,
		});
		agent.harness.resume();
		await vi.waitFor(async () => {
			if (!agent) throw new Error("Missing service");
			expect(
				(await readSchedules(agent.harness)).jobs.find((job) => job.id === daily.id)?.runs[0].status,
			).toBe("completed");
		});
		const request = (await agent.harness.snapshot(RunRequests, BACKGROUND_CONTEXT))?.items[0];
		if (!request) throw new Error("Missing one-off trigger");
		expect(await agent.harness.getTask(request.taskId, BACKGROUND_CONTEXT)).toMatchObject({
			kind: "imessage.schedule",
			background: true,
		});
		send.mockClear();
		await agent.deliver();
		await agent.close();
		agent = await startService(scheduledOptions);
		expect((await readSchedules(agent.harness)).jobs.find((job) => job.id === daily.id)?.runs).toHaveLength(
			1,
		);
		expect((await agent.harness.snapshot(RunRequests, BACKGROUND_CONTEXT))?.items[0]).toEqual(request);
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
		expect((await agent.harness.snapshot(effects, BACKGROUND_CONTEXT))?.values).toEqual([
			"v1:fixture-daily",
			"v1:fixture-daily",
		]);
		await agent.close();
		// A chat-less interval job keeps a ten-run history and stays quiet.
		const maintenanceMs = 6 * 3600000;
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({ time: "07:45", enabled: false, maintenanceMs }),
		);
		agent = await startService(scheduledOptions); // First deadline: one interval after creation.
		await agent.close();
		for (let index = 0; index < 12; index++) {
			now += maintenanceMs;
			agent = await startService(scheduledOptions);
			agent.harness.resume();
			await vi.waitFor(
				async () => {
					if (!agent) throw new Error("Missing service");
					const current = (await readSchedules(agent.harness)).jobs.find(
						(job) => job.id === "fixture-maintenance",
					);
					expect(current?.phase).toBe("sleep");
					expect(current?.runs[0]).toMatchObject({ status: "completed", input: { startedAt: now } });
				},
				{ timeout: 5000 },
			);
			await agent.close();
		}
		agent = await startService(scheduledOptions);
		view = await readSchedules(agent.harness);
		const maintenance = view.jobs.find((job) => job.id === "fixture-maintenance");
		if (!maintenance) throw new Error("Missing maintenance fixture");
		expect(maintenance.runs).toHaveLength(10);
		expect(view.recent).toHaveLength(10);
		expect(view.recent.map((run) => run.id)).toEqual(view.recent.map((run) => run.id).sort((a, b) => b - a));
		expect(send).toHaveBeenCalledTimes(1); // Maintenance remains quiet.
		// ADR 0054: a framework-owned job without a definition leaves the view and its timer is aborted.
		await agent.harness.commit(async (tx) => {
			const job = (await tx.doc(Schedules)).items.find((item) => item.id === "fixture-maintenance");
			if (job) job.extension = "scheduling";
		}, BACKGROUND_CONTEXT);

		// #33: multi-task schedules reload, roll back and remove safely.
		await writeFile(join(fixture, "config.json"), JSON.stringify({ time: "23:59", intervalMs: 100 }));
		await agent.command({ chatGuid: "control", guid: "add-interval", text: "/reload" });
		agent.harness.resume();
		const removedHarness = agent.harness;
		await vi.waitFor(async () =>
			expect(await removedHarness.getTask(maintenance.taskId, BACKGROUND_CONTEXT)).toMatchObject({
				state: { outcome: { status: "aborted" } },
			}),
		);
		const fixtureJobs = (await readSchedules(agent.harness)).jobs.filter((job) =>
			job.id.startsWith("fixture-"),
		);
		expect(fixtureJobs.map((job) => job.id)).toEqual(["fixture-daily", "fixture-interval"]);
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
		await writeFile(
			join(fixture, "config.json"),
			JSON.stringify({
				time: "22:59",
				intervalMs: 100,
				runRequests: [{ id: "fixture-daily-once", scheduleId: "fixture-daily", at: "now" }],
			}),
		);
		await agent.command({ chatGuid: "control", guid: "one-off-reload", text: "/reload" });
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
			JSON.stringify({
				time: "22:59",
				intervalMs: 100,
				pauseUntil: now + 300,
				runRequests: [{ id: "fixture-interval-once", scheduleId: "fixture-interval", at: "now" }],
			}),
		);
		agent = await startService(scheduledOptions);
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
			"v1:fixture-daily",
			...Array<string>(12).fill("v1:fixture-maintenance"),
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
