/**
 * Shared test helpers for BlueBubbles / iMessage tests.
 */

import { vi } from "vitest";
import type { BBClient } from "../bluebubble/client.js";
import type { BBRawMessage, BBWebhookPayload } from "../bluebubble/index.js";
import { createBBMonitor, createRawMessageQueue } from "../bluebubble/index.js";
import newMessageGroupFixture from "./fixtures/new-message-group.json" with { type: "json" };
import newMessageFixture from "./fixtures/new-message.json" with { type: "json" };

// ── Mock BBClient ─────────────────────────────────────────────────────────────

const FAKE_IMAGE_BYTES = Buffer.from("fakeimagebytes");

export function makeMockBBClient(): BBClient {
	return {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
		sendReaction: vi.fn().mockResolvedValue(undefined),
		downloadAttachmentBytes: vi.fn().mockResolvedValue(FAKE_IMAGE_BYTES),
	};
}

// ── Payload factories ─────────────────────────────────────────────────────────

export function makePayload(overrides: Partial<BBWebhookPayload["data"]> = {}): BBWebhookPayload {
	return {
		...newMessageFixture,
		data: { ...newMessageFixture.data, ...overrides },
	} as BBWebhookPayload;
}

export function makeGroupPayload(overrides: Partial<BBWebhookPayload["data"]> = {}): BBWebhookPayload {
	return {
		...newMessageGroupFixture,
		data: { ...newMessageGroupFixture.data, ...overrides },
	} as BBWebhookPayload;
}

// ── Monitor helpers ───────────────────────────────────────────────────────────

export function makeMonitor() {
	const queue = createRawMessageQueue();
	const monitor = createBBMonitor({ port: 0, queue });
	return { monitor, queue };
}

/**
 * Handle a webhook and pull the queued raw message (or return null on timeout).
 * Useful for testing that filtered messages never enter the queue.
 */
export async function pullRawAfterWebhook(
	{ monitor, queue }: ReturnType<typeof makeMonitor>,
	payload: BBWebhookPayload,
	timeoutMs = 200
): Promise<BBRawMessage | null> {
	monitor.handleWebhook(payload);
	return Promise.race([queue.pull(), new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}
