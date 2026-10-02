import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionToolContext, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCronService } from "../cron.js";
import { createReminderService } from "../reminders.js";
import { type ScheduledSubmission, createSchedulerService, parseSchedulerTime } from "../scheduler.js";

const directories: string[] = [];
const services: { stop(): Promise<void> }[] = [];
function workspace() {
	const directory = mkdtempSync(join(tmpdir(), "shared-scheduler-"));
	directories.push(directory);
	return directory;
}
function cronWorkspace() {
	const directory = workspace();
	mkdirSync(join(directory, "cron"));
	writeFileSync(
		join(directory, "cron/jobs.json"),
		JSON.stringify({
			version: 1,
			jobs: [
				{
					id: "check",
					schedule: "* * * * *",
					timeoutSeconds: 1,
					action: { type: "prompt", chatGuid: "chat", prompt: "check" },
				},
			],
		})
	);
	return directory;
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
});
afterEach(async () => {
	for (const service of services.splice(0)) await service.stop();
	vi.useRealTimers();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("shared extension services", () => {
	it("ships byte-exact extension sources with SHA256 provenance", () => {
		const provenance = JSON.parse(
			readFileSync(new URL("../shared-scheduler/provenance.json", import.meta.url), "utf8")
		) as { files: Record<string, string> };
		for (const [file, hash] of Object.entries(provenance.files)) {
			expect(
				createHash("sha256")
					.update(readFileSync(new URL(`../shared-scheduler/${file}`, import.meta.url)))
					.digest("hex")
			).toBe(hash);
		}
	});

	it("catches up one loop iteration after restart with owner-scoped cancellation and immutable idempotency", async () => {
		const workingDir = workspace();
		const deliver = vi.fn(async (_submission: ScheduledSubmission) => {});
		let service = createSchedulerService({ workingDir, deliver });
		services.push(service);
		const input = {
			owner: "chat-a",
			prompt: "inspect",
			fireAt: parseSchedulerTime("1m"),
			intervalMs: 60_000,
			idempotencyKey: "loop",
		};
		const task = service.schedule(input);
		expect(service.schedule(input).id).toBe(task.id);
		expect(service.cancel(task.id, "chat-b")).toBeNull();
		await service.stop();
		vi.setSystemTime(Date.now() + 300_000);
		service = createSchedulerService({ workingDir, deliver });
		services.push(service);
		service.start();
		await vi.advanceTimersByTimeAsync(1);
		expect(deliver).toHaveBeenCalledOnce();
		expect(deliver.mock.calls[0][0].text).toContain(`call cancel_scheduled_task with id=${task.id}`);
		expect(service.history(task.id).map((run) => run.status)).toEqual(["pending", "running", "accepted"]);
		expect(service.schedule(input).id).toBe(task.id);
		expect(service.list("chat-b")).toEqual([]);
		expect(service.cancel(task.id, "chat-a")?.status).toBe("cancelled");
	});

	it("retains submission run ids through retry and restart", async () => {
		const workingDir = workspace();
		const deliver = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
		let service = createSchedulerService({ workingDir, deliver, retryBaseMs: 1_000 });
		services.push(service);
		service.schedule({ owner: "chat", prompt: "check", fireAt: Date.now() });
		service.start();
		await vi.advanceTimersByTimeAsync(1);
		const runId = deliver.mock.calls[0][0].runId;
		await service.stop();
		service = createSchedulerService({ workingDir, deliver, retryBaseMs: 1_000 });
		services.push(service);
		service.start();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(deliver.mock.calls[1][0].runId).toBe(runId);
		expect(service.list()[0].status).toBe("accepted");
	});

	it("fences reminder and prompt workers without arming duplicate timers", async () => {
		const workingDir = workspace();
		for (const create of [createReminderService, createSchedulerService]) {
			const first = create({ workingDir, deliver: vi.fn() });
			const second = create({ workingDir, deliver: vi.fn() });
			services.push(first, second);
			first.start();
			expect(() => second.start()).toThrow();
			await first.stop();
			second.start();
		}
	});

	it("does not resend a reminder whose delivery was interrupted by a crash", async () => {
		const workingDir = workspace();
		const deliver = vi.fn(async () => {});
		let service = createReminderService({ workingDir, deliver });
		services.push(service);
		const { reminder } = service.create({ chatGuid: "chat", text: "check", scheduledAt: new Date().toISOString() });
		await service.stop();
		const db = new Database(join(workingDir, "reminders.db"));
		db.prepare("INSERT INTO reminder_history(reminderId,status,at) VALUES (?,'attempt',?)").run(
			reminder.id,
			Date.now()
		);
		db.close();
		service = createReminderService({ workingDir, deliver });
		services.push(service);
		service.start();
		await vi.advanceTimersByTimeAsync(1);
		expect(deliver).not.toHaveBeenCalled();
		expect(service.list()[0]).toMatchObject({ status: "failed", lastError: expect.stringContaining("not resent") });
	});

	it("aborts cooperative cron work on shutdown as a settled outcome, not a restart block", async () => {
		const workingDir = cronWorkspace();
		const execute = vi.fn(
			(_job: unknown, signal: AbortSignal) =>
				new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
		);
		let service = createCronService({ workingDir, execute });
		services.push(service);
		const run = service.runNow("check");
		await vi.advanceTimersByTimeAsync(0);
		await service.stop();
		expect(await run).toMatchObject({ status: "failed", error: "aborted by service shutdown; not replayed" });
		service = createCronService({ workingDir, execute: vi.fn() });
		services.push(service);
		service.start();
		expect(service.list()[0].blocked).toBe(false);
	});

	it("persists a cron start and holds its overlap fence after timeout until settlement", async () => {
		const workingDir = cronWorkspace();
		let finish: (() => void) | undefined;
		const execute = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const service = createCronService({ workingDir, execute });
		services.push(service);
		const first = service.runNow("check");
		expect(service.listRuns()[0].status).toBe("running");
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await first).status).toBe("timeout");
		expect((await service.runNow("check")).status).toBe("skipped-overlap");
		expect(execute).toHaveBeenCalledOnce();
		finish?.();
		await vi.advanceTimersByTimeAsync(1);
		expect(service.list()[0].running).toBe(false);
	});

	it("blocks interrupted cron work instead of replaying an unknown side effect", async () => {
		const workingDir = cronWorkspace();
		const db = new Database(join(workingDir, "cron/scheduler.db"));
		db.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,jobId TEXT NOT NULL,data TEXT NOT NULL)");
		db.prepare("INSERT INTO runs VALUES (?,?,?)").run(
			"interrupted",
			"check",
			JSON.stringify({
				id: "interrupted",
				jobId: "check",
				status: "running",
				startedAt: new Date().toISOString(),
				finishedAt: null,
				error: null,
				trigger: "scheduled",
			})
		);
		db.close();
		const execute = vi.fn();
		const service = createCronService({ workingDir, execute });
		services.push(service);
		service.start();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(execute).not.toHaveBeenCalled();
		expect(() => service.runNow("check")).toThrow("unknown previous outcome");
		expect(service.listRuns()[0].error).toContain("job blocked");
	});

	it("loads the actual terminal extension and preserves deferred tools and shutdown/rearm behavior", async () => {
		const workingDir = workspace();
		const loaded = await discoverAndLoadExtensions(
			[fileURLToPath(new URL("../shared-scheduler/index.ts", import.meta.url))],
			workingDir,
			workingDir
		);
		expect(loaded.errors).toEqual([]);
		const extension = loaded.extensions[0];
		expect([...extension.tools.keys()]).toEqual(["schedule_task", "cancel_scheduled_task", "list_scheduled_tasks"]);
		const send = vi.fn();
		loaded.runtime.sendUserMessage = send;
		const context = {
			cwd: workingDir,
			hasUI: false,
			isIdle: () => true,
			sessionManager: { getSessionFile: () => null },
		} as unknown as ExtensionToolContext;
		for (const handler of extension.handlers.get("session_start") ?? [])
			await handler({ type: "session_start" }, context);
		expect(extension.tools.get("schedule_task")?.definition.exposure).toBe("deferred");
		await extension.tools
			.get("schedule_task")
			?.definition.execute("schedule", { when: "2s", prompt: "inspect" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(send).toHaveBeenCalledWith("inspect", undefined);
		send.mockClear();
		await extension.tools
			.get("schedule_task")
			?.definition.execute("schedule-next", { when: "2s", prompt: "inspect next" }, undefined, undefined, context);
		for (const handler of extension.handlers.get("session_shutdown") ?? [])
			await handler({ type: "session_shutdown" }, context);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(send).not.toHaveBeenCalled();
	});
});
