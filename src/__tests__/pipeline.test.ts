import { describe, expect, it, vi } from "vitest";
import { createMessagePipeline } from "../pipeline.js";
import type { ChatContext, IncomingMessage, OutgoingMessage } from "../types.js";

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		chatGuid: "iMessage;-;+1111111111",
		text: "hello",
		sender: "+1111111111",
		messageType: "imessage",
		groupName: "",
		replyToText: null,
		attachments: [],
		images: [],
		...overrides,
	};
}

// ── before phase ──────────────────────────────────────────────────────────────

describe("before phase", () => {
	it("passes message through when all before-tasks continue", async () => {
		const pipeline = createMessagePipeline();
		const startFn = vi.fn();
		pipeline.before((_chat, _incoming, outgoing) => outgoing);
		pipeline.start(async (_chat, _incoming, _outgoing, _dispatch) => {
			startFn();
		});

		await pipeline.process(makeMessage());
		expect(startFn).toHaveBeenCalledTimes(1);
	});

	it("drops message when a before-task sets shouldContinue to false", async () => {
		const pipeline = createMessagePipeline();
		const startFn = vi.fn();
		pipeline.before((_chat, _incoming, outgoing) => ({ ...outgoing, shouldContinue: false }));
		pipeline.start(async (_chat, _incoming, _outgoing, _dispatch) => {
			startFn();
		});

		const result = await pipeline.process(makeMessage());
		expect(result.shouldContinue).toBe(false);
		expect(startFn).not.toHaveBeenCalled();
	});
});

// ── start + end phase ─────────────────────────────────────────────────────────

describe("start + end phase", () => {
	it("end tasks run for each dispatched reply", async () => {
		const pipeline = createMessagePipeline();
		const endTask = vi.fn((_chat: ChatContext, outgoing: OutgoingMessage) => outgoing);
		pipeline.start(async (_chat, _incoming, outgoing, dispatch) => {
			await dispatch({ ...outgoing, reply: { type: "message" as const, text: "first" } });
			await dispatch({ ...outgoing, reply: { type: "message" as const, text: "second" } });
		});
		pipeline.end(endTask);

		await pipeline.process(makeMessage());
		expect(endTask).toHaveBeenCalledTimes(2);
		expect(endTask).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			expect.objectContaining({ reply: { type: "message", text: "first" } })
		);
		expect(endTask).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			expect.objectContaining({ reply: { type: "message", text: "second" } })
		);
	});

	it("end tasks are skipped when before-task drops the message", async () => {
		const pipeline = createMessagePipeline();
		const endTask = vi.fn((_chat: ChatContext, outgoing: OutgoingMessage) => outgoing);
		pipeline.before((_chat, _incoming, outgoing) => ({ ...outgoing, shouldContinue: false }));
		pipeline.end(endTask);

		await pipeline.process(makeMessage());
		expect(endTask).not.toHaveBeenCalled();
	});

	it("end tasks receive ChatContext and dispatched outgoing", async () => {
		const pipeline = createMessagePipeline();
		const endTask = vi.fn((_chat: ChatContext, outgoing: OutgoingMessage) => outgoing);
		pipeline.start(async (_chat, _incoming, outgoing, dispatch) => {
			await dispatch({ ...outgoing, reply: { type: "message" as const, text: "pong" } });
		});
		pipeline.end(endTask);

		const msg = makeMessage({ text: "ping" });
		await pipeline.process(msg);
		expect(endTask).toHaveBeenCalledWith(
			expect.objectContaining({ chatGuid: msg.chatGuid, messageType: msg.messageType }),
			expect.objectContaining({ reply: { type: "message", text: "pong" } })
		);
	});
});
