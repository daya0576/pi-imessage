import { describe, expect, it, vi } from "vitest";
import type { DigestLogger } from "../logger.js";
import { createSelfEchoFilter } from "../self-echo.js";
import {
	createCallAgentTask,
	createDropSelfEchoTask,
	createLogIncomingTask,
	createLogOutgoingTask,
	createSendReplyTask,
} from "../tasks.js";
import type { AgentReply, IncomingMessage, OutgoingMessage } from "../types.js";
import { createOutgoingMessage } from "../types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		chatGuid: "iMessage;-;+1111111111",
		text: "hello",
		sender: "+1111111111",
		messageType: "imessage",
		groupName: "",
		attachments: [],
		images: [],
		...overrides,
	};
}

function makeOutgoing(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
	return { ...createOutgoingMessage(), ...overrides };
}

function makeDigestLogger(): DigestLogger {
	return { log: (msg: string) => console.log(msg), close: () => {} };
}

function makeMockSender() {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
	};
}

// ── before: logIncoming ───────────────────────────────────────────────────────

describe("createLogIncomingTask", () => {
	it("passes the outgoing through unchanged", () => {
		const task = createLogIncomingTask(makeDigestLogger());
		const outgoing = makeOutgoing();
		expect(task(makeMessage(), outgoing)).toEqual(outgoing);
	});

	it("logs DM with sender", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogIncomingTask(makeDigestLogger());
		task(makeMessage({ text: "hi" }), makeOutgoing());
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("[DM]"));
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("+1111111111"));
		spy.mockRestore();
	});

	it("logs group with group name and sender", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogIncomingTask(makeDigestLogger());
		task(makeMessage({ messageType: "group", groupName: "Family", sender: "alice" }), makeOutgoing());
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("[GROUP] Family|alice"));
		spy.mockRestore();
	});
});

// ── before: dropSelfEcho ──────────────────────────────────────────────────────

describe("createDropSelfEchoTask", () => {
	it("drops a message that matches a remembered echo", async () => {
		const echoFilter = createSelfEchoFilter();
		const task = createDropSelfEchoTask(echoFilter);
		const msg = makeMessage({ text: "pong" });

		echoFilter.remember(msg.chatGuid, "pong");
		const result = await task(msg, makeOutgoing());
		expect(result.shouldContinue).toBe(false);
	});

	it("passes through a message that is not an echo", async () => {
		const echoFilter = createSelfEchoFilter();
		const task = createDropSelfEchoTask(echoFilter);
		const msg = makeMessage({ text: "hello" });

		const result = await task(msg, makeOutgoing());
		expect(result.shouldContinue).toBe(true);
	});
});

// ── start: callAgent ──────────────────────────────────────────────────────────

describe("createCallAgentTask", () => {
	it("dispatches a reply for each agent turn", async () => {
		const agent = {
			processMessage: vi.fn(async (_msg: IncomingMessage, onReply: (r: AgentReply) => Promise<void>) => {
				await onReply({ kind: "assistant", text: "first reply" });
				await onReply({ kind: "assistant", text: "second reply" });
			}),
			newSession: vi.fn(async () => {}),
			getSessionStatus: vi.fn(async () => "↑0 ↓0"),
		};
		const task = createCallAgentTask(agent);
		const dispatched: OutgoingMessage[] = [];
		const dispatch = vi.fn(async (out: OutgoingMessage) => {
			dispatched.push(out);
		});

		await task(makeMessage(), makeOutgoing(), dispatch);

		expect(dispatched).toHaveLength(2);
		expect(dispatched[0].reply).toEqual({ type: "message", text: "first reply" });
		expect(dispatched[1].reply).toEqual({ type: "message", text: "second reply" });
	});

	it("dispatches nothing when agent produces no turns", async () => {
		const agent = {
			processMessage: vi.fn(async () => {}),
			newSession: vi.fn(async () => {}),
			getSessionStatus: vi.fn(async () => "↑0 ↓0"),
		};
		const task = createCallAgentTask(agent);
		const dispatch = vi.fn();

		await task(makeMessage(), makeOutgoing(), dispatch);
		expect(dispatch).not.toHaveBeenCalled();
	});
});

// ── end: sendReply ────────────────────────────────────────────────────────────

describe("createSendReplyTask", () => {
	it("sends text reply and remembers echo", async () => {
		const echoFilter = createSelfEchoFilter();
		const sender = makeMockSender();
		const task = createSendReplyTask(echoFilter, sender);
		const msg = makeMessage();
		const outgoing = makeOutgoing({ reply: { type: "message", text: "pong" } });

		await task(msg, outgoing);

		expect(sender.sendMessage).toHaveBeenCalledWith(msg.chatGuid, "pong");
		expect(echoFilter.isEcho(msg.chatGuid, "pong")).toBe(true);
	});
});

// ── end: logOutgoing ──────────────────────────────────────────────────────────

describe("createLogOutgoingTask", () => {
	it("logs the outgoing text reply", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogOutgoingTask(makeDigestLogger());
		task(makeMessage(), makeOutgoing({ reply: { type: "message", text: "pong" } }));
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("pong"));
		spy.mockRestore();
	});
});
