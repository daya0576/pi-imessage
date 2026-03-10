import { describe, expect, it, vi } from "vitest";
import { createSelfEchoFilter } from "../bluebubble/index.js";
import type { DigestLogger } from "../logger.js";
import {
	createCallAgentTask,
	createDownloadImagesTask,
	createDropSelfEchoTask,
	createLogIncomingTask,
	createLogOutgoingTask,
	createSendReplyTask,
} from "../tasks.js";
import type { IncomingMessage, OutgoingMessage } from "../types.js";
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

function makeMockBBClient() {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
		sendReaction: vi.fn().mockResolvedValue(undefined),
		downloadAttachmentBytes: vi.fn().mockResolvedValue(Buffer.from("fake")),
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

// ── before: downloadImages ────────────────────────────────────────────────────

describe("createDownloadImagesTask", () => {
	const imageAttachment = { guid: "attach-001", transferName: "photo.jpg", mimeType: "image/jpeg", totalBytes: 12345 };
	const pdfAttachment = { guid: "attach-002", transferName: "doc.pdf", mimeType: "application/pdf", totalBytes: 5000 };

	it("downloads image attachments and populates incoming.images", async () => {
		const bbClient = makeMockBBClient();
		const task = createDownloadImagesTask(bbClient);
		const msg = makeMessage({ attachments: [imageAttachment] });

		await task(msg, makeOutgoing());

		expect(bbClient.downloadAttachmentBytes).toHaveBeenCalledWith("attach-001");
		expect(msg.images).toEqual([
			{ type: "image", mimeType: "image/jpeg", data: Buffer.from("fake").toString("base64") },
		]);
	});

	it("skips non-image attachments", async () => {
		const bbClient = makeMockBBClient();
		const task = createDownloadImagesTask(bbClient);
		const msg = makeMessage({ attachments: [pdfAttachment] });

		await task(msg, makeOutgoing());

		expect(bbClient.downloadAttachmentBytes).not.toHaveBeenCalled();
		expect(msg.images).toEqual([]);
	});
});

// ── start: callAgent ──────────────────────────────────────────────────────────

describe("createCallAgentTask", () => {
	it("dispatches a reply for each agent turn", async () => {
		const agent = {
			processMessage: vi.fn(async (_msg: IncomingMessage, onReply: (r: string) => Promise<void>) => {
				await onReply("first reply");
				await onReply("second reply");
			}),
			resetSession: vi.fn(async () => true),
			getSessionStatus: vi.fn(() => null),
		};
		const task = createCallAgentTask(agent);
		const dispatched: OutgoingMessage[] = [];
		const dispatch = vi.fn(async (out: OutgoingMessage) => { dispatched.push(out); });

		await task(makeMessage(), makeOutgoing(), dispatch);

		expect(dispatched).toHaveLength(2);
		expect(dispatched[0].reply).toEqual({ type: "message", text: "first reply" });
		expect(dispatched[1].reply).toEqual({ type: "message", text: "second reply" });
	});

	it("dispatches nothing when agent produces no turns", async () => {
		const agent = { processMessage: vi.fn(async () => {}), resetSession: vi.fn(async () => true), getSessionStatus: vi.fn(() => null) };
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
		const bbClient = makeMockBBClient();
		const task = createSendReplyTask(echoFilter, bbClient);
		const msg = makeMessage();
		const outgoing = makeOutgoing({ reply: { type: "message", text: "pong" } });

		await task(msg, outgoing);

		expect(bbClient.sendMessage).toHaveBeenCalledWith(msg.chatGuid, "pong");
		expect(echoFilter.isEcho(msg.chatGuid, "pong")).toBe(true);
	});

	it("sends reaction via BlueBubbles", async () => {
		const echoFilter = createSelfEchoFilter();
		const bbClient = makeMockBBClient();
		const task = createSendReplyTask(echoFilter, bbClient);
		const msg = makeMessage();
		const outgoing = makeOutgoing({
			reply: { type: "reaction", messageGuid: "msg-001", reaction: "love" },
		});

		await task(msg, outgoing);

		expect(bbClient.sendReaction).toHaveBeenCalledWith(msg.chatGuid, "msg-001", "love");
		expect(bbClient.sendMessage).not.toHaveBeenCalled();
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
