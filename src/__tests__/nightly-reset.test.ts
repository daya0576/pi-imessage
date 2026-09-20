import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowsNightlyReset, createNightlyReset } from "../nightly-reset.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "synthetic-nightly-reset-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});
const runId = "nightly-reset-2026-09-17";
function fixture() {
	for (const name of ["iMessage;+;chat1", "iMessage;-;+1000", ".task-sessions", "scratch"]) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "context.jsonl"), "synthetic context");
		writeFileSync(join(root, name, "log.jsonl"), "synthetic log");
	}
	const newSession = vi.fn(async (chatGuid: string) => {
		rmSync(join(root, chatGuid, "context.jsonl"), { force: true });
	});
	const getRuntimeStatus = () => ({
		sessionSettings: [
			{ chatGuid: "iMessage;+;chat1", sessionKey: "iMessage;+;chat1" },
			{ chatGuid: "iMessage;+;chat2", sessionKey: "iMessage;+;chat2" },
			{ chatGuid: "iMessage;+;chat3", sessionKey: "task:isolated" },
		],
	});
	return { newSession, getRuntimeStatus };
}
describe("nightly reset", () => {
	it("includes active and disk-only chats, excludes isolated tasks, preserves logs and replays only receipts", async () => {
		const agent = fixture();
		const service = createNightlyReset(root, agent);
		const result = await service.reset(runId);
		expect(result.status).toBe("completed");
		expect(result.targets).toEqual(["iMessage;+;chat1", "iMessage;+;chat2", "iMessage;-;+1000"]);
		expect(agent.newSession).toHaveBeenCalledTimes(3);
		expect(readFileSync(join(root, "iMessage;+;chat1/log.jsonl"), "utf8")).toBe("synthetic log");
		expect(existsSync(join(root, ".task-sessions/context.jsonl"))).toBe(true);
		expect(await createNightlyReset(root, agent).reset(runId)).toEqual(result);
		expect(agent.newSession).toHaveBeenCalledTimes(3);
	});
	it("waits for cancellation settlement and never reports partial failure as completed", async () => {
		const agent = fixture();
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		agent.newSession.mockImplementation(async (chatGuid) => {
			if (chatGuid === "iMessage;+;chat1") await pending;
			else throw new Error("synthetic unsettled cancellation");
		});
		const service = createNightlyReset(root, agent);
		const operation = service.reset(runId);
		expect(agent.newSession).toHaveBeenCalledTimes(3);
		expect(service.inspect(runId)?.status).toBe("running");
		await expect(service.reset("nightly-reset-2026-09-18")).rejects.toThrow("active");
		release();
		const result = await operation;
		expect(result.status).toBe("failed");
		expect(result.failed).toHaveLength(2);
		await service.reset(runId);
		expect(agent.newSession).toHaveBeenCalledTimes(3);
	});
	it("refuses a symlink target and invalid run IDs before touching sessions", async () => {
		const agent = fixture();
		rmSync(join(root, "iMessage;+;chat1/context.jsonl"));
		symlinkSync(join(root, "iMessage;+;chat1/log.jsonl"), join(root, "iMessage;+;chat1/context.jsonl"));
		const service = createNightlyReset(root, agent);
		await expect(service.reset(runId)).rejects.toThrow("symlink");
		await expect(service.reset("../escape")).rejects.toThrow("run ID");
		expect(agent.newSession).not.toHaveBeenCalled();
	});
	it("never replays a crash/unknown receipt", async () => {
		const agent = fixture();
		mkdirSync(join(root, ".nightly-reset"));
		const receipt = { runId, status: "running", targets: ["iMessage;+;chat1"], completed: [], failed: [] };
		writeFileSync(join(root, ".nightly-reset", `${runId}.json`), JSON.stringify(receipt));
		expect(await createNightlyReset(root, agent).reset(runId)).toEqual(receipt);
		expect(agent.newSession).not.toHaveBeenCalled();
	});
	it("allows only loopback maintenance with an explicit header and no browser Origin", () => {
		expect(allowsNightlyReset("127.0.0.1", undefined, "nightly-reflection")).toBe(true);
		expect(allowsNightlyReset("::1", undefined, "nightly-reflection")).toBe(true);
		expect(allowsNightlyReset("192.0.2.1", undefined, "nightly-reflection")).toBe(false);
		expect(allowsNightlyReset("127.0.0.1", "https://example.test", "nightly-reflection")).toBe(false);
		expect(allowsNightlyReset("127.0.0.1", undefined, undefined)).toBe(false);
	});
});
