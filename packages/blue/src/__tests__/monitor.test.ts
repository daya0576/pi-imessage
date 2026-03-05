import { describe, expect, it } from "vitest";
import type { BBRawMessage, BBWebhookPayload } from "../bluebubble/index.js";
import { createBBMonitor, createRawMessageQueue } from "../bluebubble/index.js";
import { makePayload, makeGroupPayload, makeMonitor, pullRawAfterWebhook } from "./helpers.js";

// ── webhook monitor filtering ─────────────────────────────────────────────────

describe("webhook filtering", () => {
	it("ignores self-sent messages (isFromMe=true)", async () => {
		const raw = await pullRawAfterWebhook(makeMonitor(), makePayload({ isFromMe: true }));
		expect(raw).toBeNull();
	});

	it("ignores messages without text and without attachments", async () => {
		const monitorHandle = makeMonitor();
		const raw1 = await pullRawAfterWebhook(monitorHandle, makePayload({ text: null, attachments: [] }));
		const raw2 = await pullRawAfterWebhook(monitorHandle, makePayload({ text: "  ", attachments: [] }));
		expect(raw1).toBeNull();
		expect(raw2).toBeNull();
	});

	it("ignores non new-message events", async () => {
		const raw = await pullRawAfterWebhook(makeMonitor(), { type: "updated-message", data: makePayload().data });
		expect(raw).toBeNull();
	});

	it("queues valid inbound message as BBRawMessage", async () => {
		const raw = await pullRawAfterWebhook(makeMonitor(), makePayload());
		expect(raw).not.toBeNull();
		expect(raw!.text).toBe("hello blue");
		expect(raw!.handle?.address).toBe("+1234567890");
		expect(raw!.chats[0].guid).toBe("any;-;+1234567890");
	});

	it("queues group message as BBRawMessage", async () => {
		const raw = await pullRawAfterWebhook(makeMonitor(), makeGroupPayload());
		expect(raw).not.toBeNull();
		expect(raw!.text).toBe("Test message");
		expect(raw!.handle?.address).toBe("alice@example.com");
		expect(raw!.chats[0].guid).toBe("iMessage;+;chatdeadbeefdeadbeefdeadbeefdeadbeef");
		expect(raw!.chats[0].displayName).toBe("Test Group");
	});

	it("queues messages with only attachments (no text)", async () => {
		const imageAttachment = { guid: "attach-001", transferName: "photo.jpg", mimeType: "image/jpeg", totalBytes: 12345 };
		const raw = await pullRawAfterWebhook(makeMonitor(), makePayload({ text: null, attachments: [imageAttachment] }));
		expect(raw).not.toBeNull();
		expect(raw!.text).toBeNull();
		expect(raw!.attachments).toHaveLength(1);
	});

	it("ignores messages without a chatGuid", async () => {
		const raw = await pullRawAfterWebhook(makeMonitor(), makePayload({ chats: [] }));
		expect(raw).toBeNull();
	});
});
