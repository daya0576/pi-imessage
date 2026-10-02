import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAsyncQueue } from "../queue.js";
import { createSchedulerDelivery } from "../scheduler-delivery.js";
import type { ScheduledSubmission } from "../scheduler.js";
import type { IncomingMessage } from "../types.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const task: ScheduledSubmission = {
	id: "task-1",
	owner: "iMessage;+;synthetic",
	prompt: "inspect only",
	fireAt: 0,
	intervalMs: null,
	createdAt: 0,
	status: "running",
	idempotencyKey: "call-1",
	attempts: 1,
	runId: "run-1",
	nextAttempt: 0,
	text: "inspect only",
};
function queue() {
	const directory = mkdtempSync(join(tmpdir(), "scheduler-delivery-"));
	directories.push(directory);
	const path = join(directory, "queue.json");
	return { path, queue: createAsyncQueue<IncomingMessage>(path) };
}

describe("service-owned scheduler delivery", () => {
	it("queues one chat-owned prompt and deduplicates acceptance after ack and restart", async () => {
		const original = queue();
		const settings = () => ({ chatAllowlist: { whitelist: [task.owner], blacklist: ["*"] } });
		await createSchedulerDelivery(original.queue, settings)(task);
		const message = await original.queue.pull();
		expect(message).toMatchObject({
			chatGuid: task.owner,
			messageType: "group",
			sender: "scheduler:task-1",
			text: task.text,
		});
		original.queue.ack(message);
		const restarted = createAsyncQueue<IncomingMessage>(original.path);
		await createSchedulerDelivery(restarted, settings)(task);
		expect(JSON.parse(readFileSync(original.path, "utf8"))).toEqual({
			pending: [],
			inflight: [],
			acceptedKeys: ["scheduled:run-1"],
		});
	});

	it("rejects disabled chats before durable acceptance", async () => {
		const original = queue();
		await expect(
			createSchedulerDelivery(original.queue, () => ({
				chatAllowlist: { whitelist: [], blacklist: ["*"] },
			}))(task)
		).rejects.toThrow("no longer enabled");
	});
});
