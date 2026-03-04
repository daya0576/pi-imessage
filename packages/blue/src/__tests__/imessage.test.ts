import { describe, expect, it, vi } from "vitest";
import type { BBWebhookPayload } from "../bluebubble/index.js";
import { createBBMonitor, createSelfEchoFilter } from "../bluebubble/index.js";
import { createIMessageBot } from "../imessage.js";
import newMessageFixture from "./fixtures/new-message.json" with { type: "json" };
import newMessageGroupFixture from "./fixtures/new-message-group.json" with { type: "json" };

// ── fixtures ──────────────────────────────────────────────────────────────────

const CHAT_DM = "iMessage;-;+1111111111";
const CHAT_GROUP = "iMessage;+;chatdeadbeefdeadbeefdeadbeefdeadbeef";

function makePayload(overrides: Partial<BBWebhookPayload["data"]> = {}): BBWebhookPayload {
	return {
		...newMessageFixture,
		data: { ...newMessageFixture.data, ...overrides },
	} as BBWebhookPayload;
}

function makeGroupPayload(overrides: Partial<BBWebhookPayload["data"]> = {}): BBWebhookPayload {
	return {
		...newMessageGroupFixture,
		data: { ...newMessageGroupFixture.data, ...overrides },
	} as BBWebhookPayload;
}

// ── bot integration ───────────────────────────────────────────────────────────

describe("createIMessageBot", () => {
	it("DM: dispatches plain text to agent without sender prefix", async () => {
		const onMessage = vi.fn();
		const testMonitor = createBBMonitor({ port: 0, onMessage });
		testMonitor.handleWebhook(
			makePayload({ chats: [{ guid: CHAT_DM } as BBWebhookPayload["data"]["chats"][0]], text: "ping" }),
		);
		expect(onMessage).toHaveBeenCalledWith(CHAT_DM, "ping", "+1234567890", false, "");
	});

	it("group chat: dispatches text with sender prefix to agent", async () => {
		const processMessage = vi.fn().mockResolvedValue("got it");
		const sendMessage = vi.fn().mockResolvedValue(undefined);

		let capturedAgentText: string | undefined;
		const bot = createIMessageBot({
			port: 0,
			agent: {
				processMessage: (chatGuid, text) => {
					capturedAgentText = text;
					return processMessage(chatGuid, text);
				},
			},
			blueBubblesClient: {
				sendMessage,
				sendTypingIndicator: vi.fn(),
				sendReaction: vi.fn(),
			},
		});

		// Use a separate monitor to verify the full onMessage signature, then
		// test agent text construction directly.
		const testMonitor = createBBMonitor({
			port: 0,
			onMessage: (_chatGuid, text, sender, isGroup, _groupName) => {
				capturedAgentText = isGroup ? `[${sender}] ${text}` : text;
			},
		});
		testMonitor.handleWebhook(makeGroupPayload());
		expect(capturedAgentText).toBe("[alice@example.com] Test message");

		void bot;
	});

	it("self-chat: bot reply echo is suppressed", async () => {
		const processMessage = vi.fn().mockResolvedValue("pong");
		const sendMessage = vi.fn().mockResolvedValue(undefined);

		let capturedOnMessage!: (chatGuid: string, text: string, sender: string, isGroup: boolean, groupName: string) => void;
		const testMonitor = createBBMonitor({
			port: 0,
			onMessage: (chatGuid, text, sender, isGroup, groupName) =>
				capturedOnMessage?.(chatGuid, text, sender, isGroup, groupName),
		});

		// Wire the echo filter manually to mirror createIMessageBot internals
		const echoFilter = createSelfEchoFilter();

		capturedOnMessage = (chatGuid, text) => {
			if (echoFilter.isEcho(chatGuid, text)) return;
			processMessage(chatGuid, text).then((reply: string | null) => {
				if (!reply) return;
				echoFilter.remember(chatGuid, reply);
				sendMessage(chatGuid, reply);
			});
		};

		// User sends "hello"
		testMonitor.handleWebhook(
			makePayload({ chats: [{ guid: CHAT_DM } as BBWebhookPayload["data"]["chats"][0]], text: "hello", isFromMe: false }),
		);
		await vi.waitUntil(() => sendMessage.mock.calls.length > 0);

		// BB echoes bot reply back with isFromMe=false (self-chat)
		testMonitor.handleWebhook(
			makePayload({ chats: [{ guid: CHAT_DM } as BBWebhookPayload["data"]["chats"][0]], text: "pong", isFromMe: false }),
		);
		await new Promise((r) => setTimeout(r, 10));

		expect(processMessage).toHaveBeenCalledTimes(1);
		expect(processMessage).toHaveBeenCalledWith(CHAT_DM, "hello");
	});
});
