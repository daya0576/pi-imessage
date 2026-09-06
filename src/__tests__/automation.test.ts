import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import {
	type AutomationJob,
	type AutomationService,
	createAutomationService,
	parseAutomationConfig,
	parseDriverResult,
} from "../automation.js";
import { handleAutomationRequest } from "../web/automation.js";
import { renderTasksPage } from "../web/render.js";

const directories: string[] = [];
const services: AutomationService[] = [];
function fixture(
	script = 'console.log(JSON.stringify({status:"healthy",summary:"OK"}))',
	overrides: Partial<AutomationJob> = {},
	notify?: (chat: string, text: string) => Promise<void>
) {
	const workingDir = mkdtempSync(join(tmpdir(), "automation-test-"));
	directories.push(workingDir);
	mkdirSync(join(workingDir, "automation"));
	const driver = join(workingDir, "driver.cjs");
	writeFileSync(driver, script);
	const job = {
		id: "check",
		name: '<img src=x onerror="alert(1)">',
		enabled: true,
		schedule: "0 * * * *",
		timezone: "Asia/Shanghai",
		timeoutSeconds: 3,
		argv: [process.execPath, driver],
		chatGuid: "private-chat-secret",
		...overrides,
	};
	writeFileSync(join(workingDir, "automation/jobs.json"), JSON.stringify({ version: 1, jobs: [job] }));
	const service = createAutomationService({ workingDir, notify });
	services.push(service);
	service.start();
	return { service, workingDir, driver, job };
}
async function finished(service: AutomationService) {
	await vi.waitFor(() => expect(service.list()[0].running).toBe(false), { timeout: 6000, interval: 20 });
	return service.listRuns()[0];
}
afterEach(async () => {
	for (const service of services.splice(0)) await service.stop();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

it("accepts only exact structured results, bounds text and never returns raw malformed output", () => {
	expect(parseDriverResult('secret log\n{"status":"healthy","summary":"OK"}\n')).toEqual({
		status: "healthy",
		summary: "OK",
	});
	for (const output of [
		"password=secret",
		'{"status":"success","summary":"OK"}',
		'{"status":"healthy","summary":"OK","secret":"value"}',
	]) {
		expect(parseDriverResult(output)).toMatchObject({ status: "failed", summary: "Invalid driver result" });
	}
	expect(parseDriverResult(JSON.stringify({ status: "failed", summary: "x".repeat(2000) })).summary).toHaveLength(500);
});

it("validates reviewed config and safe ids without reflecting secrets", () => {
	const { job } = fixture();
	for (const changes of [{ id: "../check" }, { id: undefined }, { argv: ["node"] }, { schedule: "secret invalid" }]) {
		expect(() => parseAutomationConfig(JSON.stringify({ version: 1, jobs: [{ ...job, ...changes }] }))).toThrow(
			"Invalid reviewed automation configuration"
		);
	}
});

it("persists healthy results, escapes payloads and excludes private configuration", async () => {
	const { service, workingDir } = fixture();
	service.action("check", "run");
	expect((await finished(service)).status).toBe("healthy");
	const data = { tasks: service.list(), runs: service.listRuns() };
	const html = renderTasksPage(data);
	expect(html).toContain("&lt;img");
	expect(html).not.toContain("<img src=x");
	for (const secret of [workingDir, "private-chat-secret", "argv", "chatGuid", "cwd"])
		expect(JSON.stringify(data) + html).not.toContain(secret);
	await service.stop();
	const reopened = createAutomationService({ workingDir });
	services.push(reopened);
	expect(reopened.list()[0].lastSuccess).toBeTruthy();
	expect(reopened.listRuns()[0].status).toBe("healthy");
});

it("requires Resume verification after human handoff and notifies once per incident and recovery", async () => {
	const notify = vi.fn().mockResolvedValue(undefined);
	const { service, driver } = fixture(
		'console.log(JSON.stringify({status:"needs_human",summary:"Complete verification"}))',
		{},
		notify
	);
	service.action("check", "run");
	await finished(service);
	expect(service.list()[0]).toMatchObject({ paused: 1, state: "needs_human", notification: "accepted" });
	expect(() => service.action("check", "run")).toThrow();
	service.action("check", "resume");
	await finished(service);
	expect(notify).toHaveBeenCalledTimes(1);
	writeFileSync(driver, 'console.log(JSON.stringify({status:"healthy",summary:"Verified"}))');
	service.action("check", "resume");
	expect(service.list()[0].state).toBe("running");
	await finished(service);
	expect(service.list()[0]).toMatchObject({ paused: 0, state: "healthy" });
	expect(notify).toHaveBeenCalledTimes(2);
});

it("retains failed notifications and retries bounded later across restart", async () => {
	const notify = vi.fn().mockRejectedValue(new Error("secret sender error"));
	const { service, workingDir } = fixture('console.log("not JSON secret")', {}, notify);
	service.action("check", "run");
	await finished(service);
	expect(service.list()[0].notification).toBe("pending");
	await service.stop();
	const db = new Database(join(workingDir, "automation/automation.db"));
	db.prepare("UPDATE notifications SET retryAt=0").run();
	db.close();
	const accepted = vi.fn().mockResolvedValue(undefined);
	const reopened = createAutomationService({ workingDir, notify: accepted });
	services.push(reopened);
	reopened.start();
	await vi.waitFor(() => expect(reopened.list()[0].notification).toBe("accepted"));
	expect(accepted).toHaveBeenCalledOnce();
});

it("rejects overlap, pause keeps lock during SIGTERM grace, and cancellation cannot finish healthy", async () => {
	const { service } = fixture(
		'process.on("SIGTERM",()=>{console.log(JSON.stringify({status:"healthy",summary:"late"}));setTimeout(()=>process.exit(0),300)}); console.log("ready");setInterval(()=>{},1000)'
	);
	service.action("check", "run");
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(() => service.action("check", "run")).toThrow();
	service.action("check", "pause");
	expect(() => service.action("check", "resume")).toThrow();
	await finished(service);
	expect(service.listRuns()).toHaveLength(1);
	expect(service.listRuns()[0]).toMatchObject({ status: "failed", reason: "Manually paused" });
});

it("times out a SIGTERM-resistant process tree before unlocking", async () => {
	const { service } = fixture(
		`const {spawn}=require("node:child_process"); spawn(process.execPath,["-e", ${JSON.stringify('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)')}],{stdio:"ignore"});process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`,
		{ timeoutSeconds: 0.2 }
	);
	service.action("check", "run");
	const run = await finished(service);
	expect(run.status).toBe("failed");
	expect(service.list()[0].blocked).toBe(0);
	expect(run.reason).toBe("Timed out");
});

it("treats nonzero exit as failure even with a healthy JSON result, and pauses stopped checks", async () => {
	const { service, driver, workingDir } = fixture(
		'console.log(JSON.stringify({status:"healthy",summary:"OK"}));process.exitCode=1'
	);
	service.action("check", "run");
	expect((await finished(service)).status).toBe("failed");
	writeFileSync(driver, "setInterval(()=>{},1000)");
	service.action("check", "run");
	await new Promise((resolve) => setTimeout(resolve, 100));
	await service.stop();
	const reopened = createAutomationService({ workingDir });
	services.push(reopened);
	reopened.start();
	expect(reopened.list()[0]).toMatchObject({ state: "failed", paused: 1, running: false });
	expect(reopened.listRuns()[0].reason).toBe("Worker stopped");
});

it("marks interrupted runs failed and paused, catches up only one other due check", async () => {
	const { service, workingDir } = fixture();
	await service.stop();
	const db = new Database(join(workingDir, "automation/automation.db"));
	db.prepare("INSERT INTO runs(taskId,status,startedAt,pid) VALUES ('check','running',?,NULL)").run(
		new Date().toISOString()
	);
	db.prepare("UPDATE tasks SET nextRun='2000-01-01T00:00:00.000Z'").run();
	db.close();
	const reopened = createAutomationService({ workingDir });
	services.push(reopened);
	reopened.start();
	expect(reopened.list()[0]).toMatchObject({ state: "failed", paused: 1, blocked: 1, running: false });
	expect(reopened.listRuns()[0].status).toBe("failed");
	expect(() => reopened.action("check", "resume")).toThrow();
	await reopened.stop();
	const repair = new Database(join(workingDir, "automation/automation.db"));
	repair.prepare("UPDATE tasks SET paused=0,blocked=0,nextRun='2000-01-01T00:00:00.000Z'").run();
	repair.close();
	const catchup = createAutomationService({ workingDir });
	services.push(catchup);
	catchup.start();
	await finished(catchup);
	expect(catchup.listRuns()).toHaveLength(2);
	expect(catchup.listRuns()[0].status).toBe("healthy");
});

it("serves whitelisted data; rejects cross-origin, form, large body and traversal mutations; accepts asynchronously", async () => {
	const { service, workingDir } = fixture(
		'setTimeout(()=>console.log(JSON.stringify({status:"healthy",summary:"OK"})),1000)'
	);
	const server = createServer((request, response) => {
		void handleAutomationRequest(request, response, service);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server");
	const origin = `http://127.0.0.1:${address.port}`;
	const headers = { Origin: origin, "Content-Type": "application/json", "X-Automation-Action": "1" };
	try {
		const data = await (await fetch(`${origin}/tasks/data`)).text();
		expect(data).not.toContain(workingDir);
		const overrides: Record<string, string>[] = [
			{ Origin: "http://evil.invalid" },
			{ "Sec-Fetch-Site": "cross-site" },
			{ "Content-Type": "text/plain" },
		];
		for (const override of overrides) {
			expect(
				(await fetch(`${origin}/tasks/check/run`, { method: "POST", headers: { ...headers, ...override }, body: "{}" }))
					.status
			).toBe(403);
		}
		expect((await fetch(`${origin}/tasks/check/run`, { method: "POST", headers, body: " ".repeat(2000) })).status).toBe(
			413
		);
		expect((await fetch(`${origin}/tasks/%2e%2e%2fcheck/run`, { method: "POST", headers, body: "{}" })).status).toBe(
			404
		);
		expect((await fetch(`${origin}/tasks/check/run`, { method: "POST", headers, body: "{}" })).status).toBe(202);
		expect(service.list()[0].running).toBe(true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("queues an opted-in Shanghai daily digest once across restarts", async () => {
	const { service, workingDir } = fixture(undefined, { dailySummary: true });
	await service.stop();
	const notify = vi.fn().mockResolvedValue(undefined);
	const reopened = createAutomationService({ workingDir, notify, now: () => new Date("2026-09-06T21:10:00+08:00") });
	services.push(reopened);
	reopened.start();
	await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
	expect(notify.mock.calls[0][1]).toContain("任务运行汇总");
	await reopened.stop();
	const again = createAutomationService({ workingDir, notify, now: () => new Date("2026-09-06T22:10:00+08:00") });
	services.push(again);
	again.start();
	await new Promise((r) => setTimeout(r, 100));
	expect(notify).toHaveBeenCalledTimes(1);
});
