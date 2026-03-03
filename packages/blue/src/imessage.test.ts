import { describe, expect, it, vi } from "vitest";
import type { BBWebhookPayload } from "./bluebubble/index.js";
import { createBBClient, createBBMonitor } from "./bluebubble/index.js";
import newMessageFixture from "./__tests__/fixtures/new-message.json" with { type: "json" };

function makePayload(overrides: Partial<BBWebhookPayload["data"]> = {}): BBWebhookPayload {
	return {
		...newMessageFixture,
		data: { ...newMessageFixture.data, ...overrides },
	} as BBWebhookPayload;
}

describe("webhook filtering", () => {
	it("ignores self-sent messages", () => {
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

	it("dispatches valid messages", () => {
		const onMessage = vi.fn();
		const monitor = createBBMonitor({ port: 0, onMessage });
		monitor.handleWebhook(makePayload());
		expect(onMessage).toHaveBeenCalledWith("any;-;+1234567890", "hello blue");
	});
});

describe("bb client", () => {
	it("creates client with expected methods", () => {
		const client = createBBClient({ url: "http://localhost:1234", password: "test123" });
		expect(client.sendMessage).toBeInstanceOf(Function);
		expect(client.sendTypingIndicator).toBeInstanceOf(Function);
		expect(client.sendReaction).toBeInstanceOf(Function);
	});
});
