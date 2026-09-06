import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CronConfigFile, type CronService, createCronService, parseCronConfig } from "../cron.js";

function makeWorkingDir(config: CronConfigFile): string {
	const workingDir = mkdtempSync(join(tmpdir(), "pi-imessage-cron-"));
	mkdirSync(join(workingDir, "cron"), { recursive: true });
	writeFileSync(join(workingDir, "cron", "jobs.json"), JSON.stringify(config));
	return workingDir;
}

const baseConfig: CronConfigFile = {
	version: 1,
	jobs: [
		{
			id: "morning-message",
			name: "Morning message",
			schedule: "0 9 * * *",
			timezone: "Asia/Shanghai",
			action: { type: "send", chatGuid: "iMessage;-;+11234567890", text: "good morning" },
		},
	],
};

describe("parseCronConfig", () => {
	it("validates jobs and applies defaults", () => {
		const parsed = parseCronConfig(JSON.stringify(baseConfig));
		expect(parsed.jobs[0]).toEqual(
			expect.objectContaining({ id: "morning-message", enabled: true, timezone: "Asia/Shanghai", timeoutSeconds: 300 })
		);
	});

	it("rejects duplicate ids, invalid schedules, and relative executables", () => {
		expect(() =>
			parseCronConfig(JSON.stringify({ version: 1, jobs: [baseConfig.jobs[0], baseConfig.jobs[0]] }))
		).toThrow("duplicate");
		expect(() =>
			parseCronConfig(JSON.stringify({ version: 1, jobs: [{ ...baseConfig.jobs[0], schedule: "not cron" }] }))
		).toThrow();
		expect(() =>
			parseCronConfig(
				JSON.stringify({
					version: 1,
					jobs: [{ ...baseConfig.jobs[0], action: { type: "exec", argv: ["python3", "job.py"] } }],
				})
			)
		).toThrow("absolute path");
	});
});

describe("cron service", () => {
	let workingDir: string | null = null;
	let service: CronService | null = null;

	afterEach(async () => {
		await service?.stop();
		if (workingDir) rmSync(workingDir, { recursive: true, force: true });
	});

	it("schedules enabled jobs only after the active service starts", () => {
		workingDir = makeWorkingDir(baseConfig);
		service = createCronService({ workingDir, execute: vi.fn() });
		expect(service.list()[0]?.nextRunAt).toBeNull();
		service.start();
		expect(service.list()[0]?.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("runs a job manually and persists its result history", async () => {
		workingDir = makeWorkingDir(baseConfig);
		const execute = vi.fn().mockResolvedValue(undefined);
		service = createCronService({ workingDir, execute });
		const run = await service.runNow("morning-message");

		expect(run.status).toBe("success");
		expect(execute).toHaveBeenCalledOnce();
		expect(service.list()[0]?.lastRun?.id).toBe(run.id);
		expect(readFileSync(join(workingDir, "cron", "runs.jsonl"), "utf-8")).toContain(run.id);
	});

	it("skips overlapping runs of the same job", async () => {
		workingDir = makeWorkingDir(baseConfig);
		let finish: (() => void) | undefined;
		const execute = vi.fn().mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		service = createCronService({ workingDir, execute });
		const first = service.runNow("morning-message");
		const second = await service.runNow("morning-message");
		expect(second.status).toBe("skipped-overlap");
		finish?.();
		expect((await first).status).toBe("success");
	});

	it("atomically updates enabled state in the workspace config", () => {
		workingDir = makeWorkingDir(baseConfig);
		service = createCronService({ workingDir, execute: vi.fn() });
		const updated = service.setEnabled("morning-message", false);
		expect(updated.enabled).toBe(false);
		const onDisk = JSON.parse(readFileSync(join(workingDir, "cron", "jobs.json"), "utf-8"));
		expect(onDisk.jobs[0].enabled).toBe(false);
	});

	it("keeps the last valid config when reload rejects a broken file", () => {
		workingDir = makeWorkingDir(baseConfig);
		service = createCronService({ workingDir, execute: vi.fn() });
		writeFileSync(join(workingDir, "cron", "jobs.json"), "{ broken");
		expect(() => service?.reload()).toThrow();
		expect(service.list()[0]?.id).toBe("morning-message");
	});
});
