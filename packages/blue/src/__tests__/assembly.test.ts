import { describe, expect, it, vi } from "vitest";
import { assembleMessage } from "../imessage.js";
import type { BBRawMessage } from "../bluebubble/index.js";
import { makeMockBBClient, makePayload, makeGroupPayload } from "./helpers.js";

// ── message assembly ──────────────────────────────────────────────────────────

describe("assembleMessage", () => {
	it("assembles a DM into IncomingMessage with messageType 'imessage'", async () => {
		const raw = makePayload().data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg).toEqual({
			chatGuid: "any;-;+1234567890",
			text: "hello blue",
			sender: "+1234567890",
			messageType: "imessage",
			groupName: "",
			images: [],
		});
	});

	it("assembles a group message with messageType 'group'", async () => {
		const raw = makeGroupPayload().data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg).toEqual({
			chatGuid: "iMessage;+;chatdeadbeefdeadbeefdeadbeefdeadbeef",
			text: "Test message",
			sender: "alice@example.com",
			messageType: "group",
			groupName: "Test Group",
			images: [],
		});
	});
});

// ── message type detection ────────────────────────────────────────────────────

describe("message type detection", () => {
	it("classifies iMessage DM (service=iMessage, chatGuid ;-;) as 'imessage'", async () => {
		const raw = makePayload().data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg.messageType).toBe("imessage");
	});

	it("classifies group chat (service=iMessage, chatGuid ;+;) as 'group'", async () => {
		const raw = makeGroupPayload().data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg.messageType).toBe("group");
	});

	it("classifies SMS (service=SMS) as 'sms' regardless of chatGuid", async () => {
		const raw = makePayload({ handle: { address: "+1234567890", service: "SMS" } }).data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg.messageType).toBe("sms");
	});

	it("defaults to 'imessage' when handle is null (service unknown)", async () => {
		const raw = makePayload({ handle: null }).data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg.messageType).toBe("imessage");
		expect(msg.sender).toBe("unknown");
	});
});

// ── group chat ────────────────────────────────────────────────────────────────

describe("group chat assembly", () => {
	it("falls back to 'unknown' sender when handle is null", async () => {
		const raw = makeGroupPayload({ handle: null }).data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg).toEqual(expect.objectContaining({ sender: "unknown", messageType: "group", groupName: "Test Group" }));
	});
});

// ── attachments ───────────────────────────────────────────────────────────────

describe("attachment downloading", () => {
	const imageAttachment = {
		guid: "attach-001",
		transferName: "photo.jpg",
		mimeType: "image/jpeg",
		totalBytes: 12345,
	};

	it("downloads image attachments and populates images[]", async () => {
		const bbClient = makeMockBBClient();
		const raw = makePayload({ text: null, attachments: [imageAttachment] }).data;
		const msg = await assembleMessage(raw, bbClient);
		expect(bbClient.downloadAttachmentBytes).toHaveBeenCalledWith("attach-001");
		expect(msg.images).toEqual([
			{ type: "image", mimeType: "image/jpeg", data: Buffer.from("fakeimagebytes").toString("base64") },
		]);
		expect(msg.text).toBeNull();
	});

	it("includes caption text alongside images", async () => {
		const raw = makePayload({ text: "check this out", attachments: [imageAttachment] }).data;
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg.text).toBe("check this out");
		expect(msg.images).toHaveLength(1);
	});

	it("skips non-image attachments", async () => {
		const pdfAttachment = { guid: "attach-002", transferName: "doc.pdf", mimeType: "application/pdf", totalBytes: 5000 };
		const bbClient = makeMockBBClient();
		const raw = makePayload({ text: "see attached", attachments: [pdfAttachment] }).data;
		const msg = await assembleMessage(raw, bbClient);
		expect(bbClient.downloadAttachmentBytes).not.toHaveBeenCalled();
		expect(msg.images).toEqual([]);
	});

	it("downloads image attachments in group messages", async () => {
		const bbClient = makeMockBBClient();
		const raw = makeGroupPayload({ attachments: [imageAttachment] }).data;
		const msg = await assembleMessage(raw, bbClient);
		expect(msg.messageType).toBe("group");
		expect(msg.images).toHaveLength(1);
	});

	it("silently skips failed image downloads", async () => {
		const bbClient = makeMockBBClient();
		(bbClient.downloadAttachmentBytes as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
		const raw = makePayload({ text: "look at this", attachments: [imageAttachment] }).data;
		const msg = await assembleMessage(raw, bbClient);
		expect(msg.images).toEqual([]);
	});
});
