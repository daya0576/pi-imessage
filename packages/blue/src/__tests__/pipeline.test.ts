import { describe, expect, it, vi } from "vitest";
import { createMessagePipeline } from "../pipeline.js";
import type { IncomingMessage, OutgoingMessage } from "../types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		chatGuid: "iMessage;-;+1111111111",
		text: "hello",
		sender: "+1111111111",
		messageType: "imessage",
		groupName: "",
		images: [],
		...overrides,
	};
}

// ── before phase ──────────────────────────────────────────────────────────────

describe("before phase", () => {
	it("passes message through when all before-tasks continue", async () => {
		const pipeline = createMessagePipeline();
		const startTask = vi.fn().mockImplementation((_incoming, outgoing) => ({
			...outgoing,
			reply: { type: "message", text: "reply" },
		}));
		pipeline.before((_incoming, outgoing) => outgoing);
		pipeline.start(startTask);

		await pipeline.process(makeMessage());
		expect(startTask).toHaveBeenCalledTimes(1);
	});

	it("drops message when a before-task sets shouldContinue to false", async () => {
		const pipeline = createMessagePipeline();
		const startTask = vi.fn().mockImplementation((_incoming, outgoing) => outgoing);
		pipeline.before((_incoming, outgoing) => ({ ...outgoing, shouldContinue: false }));
		pipeline.start(startTask);

		const result = await pipeline.process(makeMessage());
		expect(result.shouldContinue).toBe(false);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("short-circuits on first shouldContinue=false — later before-tasks are skipped", async () => {
		const pipeline = createMessagePipeline();
		const secondBefore = vi.fn((_incoming: IncomingMessage, outgoing: OutgoingMessage) => outgoing);
		pipeline.before((_incoming, outgoing) => ({ ...outgoing, shouldContinue: false }));
		pipeline.before(secondBefore);

		await pipeline.process(makeMessage());
		expect(secondBefore).not.toHaveBeenCalled();
	});

	it("runs before-tasks in registration order", async () => {
		const order: number[] = [];
		const pipeline = createMessagePipeline();
		pipeline.before((_incoming, outgoing) => {
			order.push(1);
			return outgoing;
		});
		pipeline.before((_incoming, outgoing) => {
			order.push(2);
			return outgoing;
		});
		pipeline.start(async (_incoming, outgoing) => outgoing);

		await pipeline.process(makeMessage());
		expect(order).toEqual([1, 2]);
	});
});

// ── start phase ───────────────────────────────────────────────────────────────

describe("start phase", () => {
	it("returns the reply set by the start-task", async () => {
		const pipeline = createMessagePipeline();
		pipeline.start(async (_incoming, outgoing) => ({
			...outgoing,
			reply: { type: "message" as const, text: "pong" },
		}));

		const result = await pipeline.process(makeMessage());
		expect(result.reply).toEqual({ type: "message", text: "pong" });
	});

	it("returns no reply when no start-task is registered", async () => {
		const pipeline = createMessagePipeline();
		const result = await pipeline.process(makeMessage());
		expect(result.reply).toEqual({ type: "none" });
	});

	it("short-circuits when start-task sets shouldContinue to false", async () => {
		const pipeline = createMessagePipeline();
		const endTask = vi.fn((_incoming: IncomingMessage, outgoing: OutgoingMessage) => outgoing);
		pipeline.start(async (_incoming, outgoing) => ({ ...outgoing, shouldContinue: false }));
		pipeline.end(endTask);

		const result = await pipeline.process(makeMessage());
		expect(result.shouldContinue).toBe(false);
		expect(endTask).not.toHaveBeenCalled();
	});
});

// ── end phase ─────────────────────────────────────────────────────────────────

describe("end phase", () => {
	it("receives incoming message and outgoing context with reply", async () => {
		const pipeline = createMessagePipeline();
		const endTask = vi.fn((_incoming: IncomingMessage, outgoing: OutgoingMessage) => outgoing);
		pipeline.start(async (_incoming, outgoing) => ({
			...outgoing,
			reply: { type: "message" as const, text: "pong" },
		}));
		pipeline.end(endTask);

		const msg = makeMessage({ text: "ping" });
		await pipeline.process(msg);

		expect(endTask).toHaveBeenCalledWith(
			msg,
			expect.objectContaining({
				reply: { type: "message", text: "pong" },
			})
		);
	});

	it("receives outgoing with no reply when start-task produces none", async () => {
		const pipeline = createMessagePipeline();
		const endTask = vi.fn((_incoming: IncomingMessage, outgoing: OutgoingMessage) => outgoing);
		pipeline.start(async (_incoming, outgoing) => outgoing);
		pipeline.end(endTask);

		await pipeline.process(makeMessage());
		expect(endTask).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				reply: { type: "none" },
			})
		);
	});

	it("is skipped when before-task drops the message", async () => {
		const pipeline = createMessagePipeline();
		const endTask = vi.fn((_incoming: IncomingMessage, outgoing: OutgoingMessage) => outgoing);
		pipeline.before((_incoming, outgoing) => ({ ...outgoing, shouldContinue: false }));
		pipeline.start(async (_incoming, outgoing) => ({
			...outgoing,
			reply: { type: "message" as const, text: "pong" },
		}));
		pipeline.end(endTask);

		await pipeline.process(makeMessage());
		expect(endTask).not.toHaveBeenCalled();
	});

	it("runs end-tasks in registration order", async () => {
		const order: number[] = [];
		const pipeline = createMessagePipeline();
		pipeline.start(async (_incoming, outgoing) => ({
			...outgoing,
			reply: { type: "message" as const, text: "reply" },
		}));
		pipeline.end((_incoming, outgoing) => {
			order.push(1);
			return outgoing;
		});
		pipeline.end((_incoming, outgoing) => {
			order.push(2);
			return outgoing;
		});

		await pipeline.process(makeMessage());
		expect(order).toEqual([1, 2]);
	});
});
