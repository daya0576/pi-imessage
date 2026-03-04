import { describe, expect, it, vi } from "vitest";
import type { BBWebhookPayload } from "../bluebubble/index.js";
import { createBBMonitor } from "../bluebubble/index.js";
import newMessageFixture from "./fixtures/new-message.json" with { type: "json" };
import newMessageGroupFixture from "./fixtures/new-message-group.json" with { type: "json" };

// ── fixtures ──────────────────────────────────────────────────────────────────

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

	it("dispatches valid inbound DM messages", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makePayload());
		expect(onMessage).toHaveBeenCalledWith("any;-;+1234567890", "hello blue", "+1234567890", false, "");
	});
});

// ── group chat ────────────────────────────────────────────────────────────────

describe("group chat", () => {
	it("dispatches group chat messages with isGroup=true and correct sender", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makeGroupPayload());
		expect(onMessage).toHaveBeenCalledWith(
			"iMessage;+;chatdeadbeefdeadbeefdeadbeefdeadbeef",
			"Test message",
			"alice@example.com",
			true,
			"Test Group",
		);
	});

	it("ignores self-sent group messages (isFromMe=true)", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makeGroupPayload({ isFromMe: true }));
		expect(onMessage).not.toHaveBeenCalled();
	});

	it("falls back to 'unknown' sender when handle is null", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makeGroupPayload({ handle: null }));
		expect(onMessage).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			"unknown",
			true,
			"Test Group",
		);
	});
});
