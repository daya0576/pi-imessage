import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BackgroundService, createBackgroundService, validateCompletionFile } from "../background.js";
const dirs: string[] = [];
const services: BackgroundService[] = [];
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "bg-watch-"));
	dirs.push(dir);
	mkdirSync(join(dir, "chat-a/scratch"), { recursive: true });
	let now = 0;
	const summarize = vi.fn(async () => "完成，结果已核对");
	const deliver = vi.fn(async () => {});
	const config = { workingDir: dir, summarize, deliver, now: () => now };
	const make = () => {
		const service = createBackgroundService(config);
		services.push(service);
		return service;
	};
	const file = join(dir, "chat-a/scratch/run-complete.json");
	const input = { chatGuid: "chat-a", completionFile: file, instruction: "Read the result, report failures honestly" };
	return {
		dir,
		make,
		file,
		input,
		summarize,
		deliver,
		setTime: (n: number) => {
			now = n;
		},
	};
}
afterEach(async () => {
	for (const s of services.splice(0)) await s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("durable background completion", () => {
	it("survives restart, delivers once after a valid marker, and registration is idempotent", async () => {
		const f = setup();
		let service = f.make();
		const job = service.create(f.input);
		expect(service.create(f.input).id).toBe(job.id);
		service.start();
		await service.tick();
		expect(f.summarize).not.toHaveBeenCalled();
		await service.stop();
		writeFileSync(f.file, JSON.stringify({ status: "failed", results: "result.json" }));
		service = f.make();
		service.start();
		await service.tick();
		await service.tick();
		expect(f.summarize).toHaveBeenCalledTimes(1);
		expect(f.deliver).toHaveBeenCalledTimes(1);
		expect(service.list()[0].state).toBe("done");
	});
	it("does not treat an incomplete write as completion", async () => {
		const f = setup();
		const service = f.make();
		service.create(f.input);
		writeFileSync(f.file, "{");
		service.start();
		await service.tick();
		expect(f.summarize).not.toHaveBeenCalled();
		for (const marker of [{}, { status: "running" }, { status: "unknown" }]) {
			writeFileSync(f.file, JSON.stringify(marker));
			await service.tick();
			expect(f.summarize).not.toHaveBeenCalled();
		}
		writeFileSync(f.file, JSON.stringify({ status: "completed" }));
		await service.tick();
		expect(f.summarize).toHaveBeenCalledOnce();
	});
	it("persists a ready summary before delivery and retries sending without rerunning the model", async () => {
		const f = setup();
		let service = f.make();
		service.create(f.input);
		writeFileSync(f.file, JSON.stringify({ status: "success" }));
		f.deliver.mockRejectedValueOnce(new Error("uncertain send"));
		service.start();
		await service.tick();
		expect(service.list()[0].state).toBe("ready");
		await service.stop();
		f.setTime(31_000);
		service = f.make();
		service.start();
		await service.tick();
		expect(f.summarize).toHaveBeenCalledTimes(1);
		expect(f.deliver).toHaveBeenCalledTimes(2);
		expect(service.list()[0].state).toBe("done");
	});
	it("bounds read-only summary retries and notifies failure instead of restarting the command", async () => {
		const f = setup();
		const service = f.make();
		service.create(f.input);
		writeFileSync(f.file, JSON.stringify({ status: "failed" }));
		f.summarize.mockRejectedValue(new Error("provider failure"));
		service.start();
		await service.tick();
		f.setTime(31_000);
		await service.tick();
		f.setTime(100_000);
		await service.tick();
		f.setTime(131_000);
		await service.tick();
		expect(f.summarize).toHaveBeenCalledTimes(3);
		expect(f.deliver).toHaveBeenCalledWith("chat-a", expect.stringContaining("未重跑原任务"), expect.any(String));
		expect(service.list()[0].state).toBe("done");
	});
	it("has a lifetime single-worker fence", async () => {
		const f = setup();
		const first = f.make();
		first.start();
		const second = f.make();
		expect(() => second.start()).toThrow();
		await first.stop();
		second.start();
		await second.tick();
	});
	it("rejects other chats and symlink escapes at registration and runtime", () => {
		const f = setup();
		const external = mkdtempSync(join(tmpdir(), "outside-bg-"));
		dirs.push(external);
		symlinkSync(external, join(f.dir, "chat-a/scratch/link"));
		expect(() => validateCompletionFile(f.dir, "chat-a", join(f.dir, "chat-b/scratch/done.json"))).toThrow();
		expect(() => validateCompletionFile(f.dir, "chat-a", join(f.dir, "chat-a/scratch/link/done.json"))).toThrow();
		expect(() => validateCompletionFile(f.dir, "../outside", f.file)).toThrow();
	});
	it("catches up a completed marker after downtime even if the deadline has passed", async () => {
		const f = setup();
		const service = f.make();
		service.create({ ...f.input, waitMinutes: 1 });
		writeFileSync(f.file, JSON.stringify({ status: "completed" }));
		f.setTime(90_000);
		service.start();
		await service.tick();
		expect(f.summarize).toHaveBeenCalledTimes(1);
		expect(service.list()[0].state).toBe("done");
	});
	it("expires malformed markers rather than polling indefinitely", async () => {
		const f = setup();
		const service = f.make();
		service.create({ ...f.input, waitMinutes: 1 });
		writeFileSync(f.file, "{");
		f.setTime(90_000);
		service.start();
		await service.tick();
		expect(f.summarize).not.toHaveBeenCalled();
		expect(f.deliver).toHaveBeenCalledWith("chat-a", expect.stringContaining("尚未确认完成"), expect.any(String));
	});
	it("reports an expired wait without claiming the background process stopped", async () => {
		const f = setup();
		const service = f.make();
		service.create({ ...f.input, waitMinutes: 1 });
		f.setTime(61_000);
		service.start();
		await service.tick();
		expect(f.summarize).not.toHaveBeenCalled();
		expect(f.deliver).toHaveBeenCalledWith("chat-a", expect.stringContaining("尚未确认完成"), expect.any(String));
	});
});
