import { describe, expect, it, vi } from "vitest";
import type { BBWebhookPayload } from "../bluebubble/index.js";
import { createBBMonitor, createSelfEchoFilter } from "../bluebubble/index.js";
import { assembleMessage } from "../imessage.js";
import { makeMockBBClient, makePayload, makeGroupPayload } from "./helpers.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CHAT_DM = "iMessage;-;+1111111111";

// ── bot integration ───────────────────────────────────────────────────────────

describe("createIMessageBot", () => {
	it("DM: raw message assembles into IncomingMessage with messageType 'imessage'", async () => {
		const monitor = createBBMonitor({ port: 0 });
		monitor.handleWebhook(
			makePayload({ chats: [{ guid: CHAT_DM } as BBWebhookPayload["data"]["chats"][0]], text: "ping" }),
		);
		const raw = await monitor.pull();
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg.messageType).toBe("imessage");
		expect(msg.text).toBe("ping");
	});

	it("group chat: raw message assembles into IncomingMessage with messageType 'group'", async () => {
		const monitor = createBBMonitor({ port: 0 });
		monitor.handleWebhook(makeGroupPayload());
		const raw = await monitor.pull();
		const msg = await assembleMessage(raw, makeMockBBClient());
		expect(msg.messageType).toBe("group");
		expect(msg.sender).toBe("alice@example.com");
		expect(msg.text).toBe("Test message");
	});

	it("self-chat: bot reply echo is suppressed via echoFilter", async () => {
		const bbClient = makeMockBBClient();
		const monitor = createBBMonitor({ port: 0 });
		const processMessage = vi.fn().mockResolvedValue("pong");
		const echoFilter = createSelfEchoFilter();

		// User sends "hello"
		monitor.handleWebhook(
			makePayload({ chats: [{ guid: CHAT_DM } as BBWebhookPayload["data"]["chats"][0]], text: "hello", isFromMe: false }),
		);
		const raw = await monitor.pull();
		const msg = await assembleMessage(raw, bbClient);

		// Simulate the bot's processing
		const reply = await processMessage(msg);
		echoFilter.remember(msg.chatGuid, reply);
		await bbClient.sendMessage(msg.chatGuid, reply);

		// BB echoes bot reply back with isFromMe=false (self-chat)
		monitor.handleWebhook(
			makePayload({ chats: [{ guid: CHAT_DM } as BBWebhookPayload["data"]["chats"][0]], text: "pong", isFromMe: false }),
		);
		const echoRaw = await monitor.pull();
		const echoMsg = await assembleMessage(echoRaw, bbClient);

		// Echo filter detects the echo
		expect(echoFilter.isEcho(echoMsg.chatGuid, echoMsg.text!)).toBe(true);
		expect(processMessage).toHaveBeenCalledTimes(1);
	});
});
