import { describe, expect, it, vi } from "vitest";
import type { BBWebhookPayload } from "../bluebubble/index.js";
import { createBBMonitor } from "../bluebubble/index.js";
import newMessageFixture from "./fixtures/new-message.json" with { type: "json" };

// ── fixtures ──────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<BBWebhookPayload["data"]> = {}): BBWebhookPayload {
	return {
		...newMessageFixture,
		data: { ...newMessageFixture.data, ...overrides },
	} as BBWebhookPayload;
}

// ── webhook monitor filtering ─────────────────────────────────────────────────

describe("webhook filtering", () => {
	it("ignores self-sent messages (isFromMe=true)", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makePayload({ isFromMe: true }));
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("ignores messages without text", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makePayload({ text: null }));
		monitor.handleWebhook(makePayload({ text: "  " }));
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("ignores non new-message events", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook({ type: "updated-message", data: makePayload().data });
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("dispatches valid inbound messages", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makePayload());
		expect(onMessage).toHaveBeenCalledWith("any;-;+1234567890", "hello blue");
	});
});
