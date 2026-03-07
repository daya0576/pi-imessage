import { describe, expect, it, vi } from "vitest";
import { createSelfEchoFilter } from "../bluebubble/index.js";
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
		const task = createLogIncomingTask();
		const outgoing = makeOutgoing();
		expect(task(makeMessage(), outgoing)).toEqual(outgoing);
	});

	it("logs DM with sender", () => {		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogIncomingTask();
		task(makeMessage({ text: "hi" }), makeOutgoing());
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("[DM]"));
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("+1111111111"));
		spy.mockRestore();
	});

	it("logs group with group name and sender", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogIncomingTask();
		task(makeMessage({ messageType: "group", groupName: "Family", sender: "alice" }), makeOutgoing());
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("[GROUP] Family|alice"));
		spy.mockRestore();
	});
});

// ── before: dropSelfEcho ──────────────────────────────────────────────────────

describe("createDropSelfEchoTask", () => {
	it("drops a message that matches a remembered echo", () => {
		const echoFilter = createSelfEchoFilter();
		const task = createDropSelfEchoTask(echoFilter);
		const msg = makeMessage({ text: "pong" });

		echoFilter.remember(msg.chatGuid, "pong");
		const result = task(msg, makeOutgoing());
		expect(result.shouldContinue).toBe(false);
	});

	it("passes through a message that is not an echo", () => {
		const echoFilter = createSelfEchoFilter();
		const task = createDropSelfEchoTask(echoFilter);
		const msg = makeMessage({ text: "hello" });

		const result = task(msg, makeOutgoing());
		expect(result.shouldContinue).toBe(true);
	});

	it("passes through a message with no text (image-only)", () => {
		const echoFilter = createSelfEchoFilter();
		const task = createDropSelfEchoTask(echoFilter);
		const msg = makeMessage({ text: null });

		const result = task(msg, makeOutgoing());
		expect(result.shouldContinue).toBe(true);
	});
});

// ── start: downloadImages ─────────────────────────────────────────────────────

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

	it("silently skips failed image downloads", async () => {
		const bbClient = makeMockBBClient();
		(bbClient.downloadAttachmentBytes as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
		const task = createDownloadImagesTask(bbClient);
		const msg = makeMessage({ attachments: [imageAttachment] });

		await task(msg, makeOutgoing());

		expect(msg.images).toEqual([]);
	});

	it("downloads images in group messages", async () => {
		const bbClient = makeMockBBClient();
		const task = createDownloadImagesTask(bbClient);
		const msg = makeMessage({ messageType: "group", attachments: [imageAttachment] });

		await task(msg, makeOutgoing());

		expect(msg.images).toHaveLength(1);
	});
});

// ── start: callAgent ──────────────────────────────────────────────────────────

describe("createCallAgentTask", () => {
	it("delegates to agent.processMessage and sets reply action", async () => {
		const agent = { processMessage: vi.fn().mockResolvedValue({ reply: "pong", errorMessage: null }) };
		const task = createCallAgentTask(agent);
		const msg = makeMessage({ text: "ping" });

		const result = await task(msg, makeOutgoing());
		expect(result.reply).toEqual({ type: "message", text: "pong" });
		expect(agent.processMessage).toHaveBeenCalledWith(msg);
	});

	it("keeps reply as 'none' when agent returns null reply", async () => {
		const agent = { processMessage: vi.fn().mockResolvedValue({ reply: null, errorMessage: null }) };
		const task = createCallAgentTask(agent);

		const result = await task(makeMessage(), makeOutgoing());
		expect(result.reply).toEqual({ type: "none" });
	});

	it("sets reply text and sendReply=false when agent returns errorMessage", async () => {
		const agent = {
			processMessage: vi.fn().mockResolvedValue({ reply: null, errorMessage: "API key missing" }),
		};
		const task = createCallAgentTask(agent);
		const msg = makeMessage({ text: "hi" });

		const result = await task(msg, makeOutgoing());
		expect(result.reply).toEqual({ type: "message", text: "API key missing" });
		expect(result.sendReply).toBe(false);
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
		// echo was remembered — the echo filter should now detect it
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

	it("does nothing when reply is 'none'", async () => {
		const echoFilter = createSelfEchoFilter();
		const bbClient = makeMockBBClient();
		const task = createSendReplyTask(echoFilter, bbClient);

		await task(makeMessage(), makeOutgoing());
		expect(bbClient.sendMessage).not.toHaveBeenCalled();
		expect(bbClient.sendReaction).not.toHaveBeenCalled();
	});
});

// ── end: logOutgoing ──────────────────────────────────────────────────────────

describe("createLogOutgoingTask", () => {
	it("logs the outgoing text reply", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogOutgoingTask();
		task(makeMessage(), makeOutgoing({ reply: { type: "message", text: "pong" } }));
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("->"));
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("pong"));
		spy.mockRestore();
	});

	it("logs the outgoing reaction", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogOutgoingTask();
		task(
			makeMessage(),
			makeOutgoing({
				reply: { type: "reaction", messageGuid: "msg-001", reaction: "love" },
			})
		);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("->"));
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("reaction: love"));
		spy.mockRestore();
	});

	it("logs group reply with group name", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const task = createLogOutgoingTask();
		task(
			makeMessage({ messageType: "group", groupName: "Family" }),
			makeOutgoing({ reply: { type: "message", text: "hi all" } })
		);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("[GROUP] Family"));
		spy.mockRestore();
	});
});
