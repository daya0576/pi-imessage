import { describe, expect, it } from "vitest";
import { assembleMessage } from "../imessage.js";
import { makeGroupPayload, makePayload } from "./helpers.js";

// ── message assembly ──────────────────────────────────────────────────────────

describe("assembleMessage", () => {
	it("assembles a DM into IncomingMessage with messageType 'imessage'", () => {
		const raw = makePayload().data;
		const msg = assembleMessage(raw);
		expect(msg).toEqual({
			chatGuid: "any;-;+1234567890",
			text: "hello blue",
			sender: "+1234567890",
			messageType: "imessage",
			groupName: "",
			attachments: [],
			images: [],
		});
	});

	it("assembles a group message with messageType 'group'", () => {
		const raw = makeGroupPayload().data;
		const msg = assembleMessage(raw);
		expect(msg).toEqual({
			chatGuid: "iMessage;+;chatdeadbeefdeadbeefdeadbeefdeadbeef",
			text: "Test message",
			sender: "alice@example.com",
			messageType: "group",
			groupName: "Test Group",
			attachments: [],
			images: [],
		});
	});

	it("classifies SMS (service=SMS) as 'sms'", () => {
		const raw = makePayload({ handle: { address: "+1234567890", service: "SMS" } }).data;
		const msg = assembleMessage(raw);
		expect(msg.messageType).toBe("sms");
	});

	it("defaults to 'imessage' and 'unknown' sender when handle is null", () => {
		const raw = makePayload({ handle: null }).data;
		const msg = assembleMessage(raw);
		expect(msg.messageType).toBe("imessage");
		expect(msg.sender).toBe("unknown");
	});

	it("falls back to 'unknown' sender in group chat when handle is null", () => {
		const raw = makeGroupPayload({ handle: null }).data;
		const msg = assembleMessage(raw);
		expect(msg).toEqual(expect.objectContaining({ sender: "unknown", messageType: "group", groupName: "Test Group" }));
	});

	it("carries raw attachments through in attachments[]", () => {
		const imageAttachment = {
			guid: "attach-001",
			transferName: "photo.jpg",
			mimeType: "image/jpeg",
			totalBytes: 12345,
		};
		const raw = makePayload({ text: null, attachments: [imageAttachment] }).data;
		const msg = assembleMessage(raw);
		expect(msg.attachments).toEqual([imageAttachment]);
		expect(msg.images).toEqual([]);
	});
});
