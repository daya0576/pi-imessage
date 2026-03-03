import { describe, expect, it, vi } from "vitest";
import type { BBWebhookPayload } from "../bluebubble/index.js";
import { createBBClient, createBlueServer } from "../bluebubble/index.js";
import newMessageFixture from "./fixtures/new-message.json" with { type: "json" };

/**
 * Unit tests for Blue server webhook handling.
 * These test the routing/filtering logic without real BB or agent connections.
 */

/**
 * Factory based on a real BlueBubbles new-message webhook payload.
 * Sensitive values (phone numbers, ROWIDs, GUIDs) are replaced with fakes.
 */
function makePayload(overrides: Partial<BBWebhookPayload["data"]> = {}): BBWebhookPayload {
	return {
		...newMessageFixture,
		data: {
			...newMessageFixture.data,
			...overrides,
		},
	} as BBWebhookPayload;
}

describe("webhook filtering", () => {
	// We test the filtering logic that would live in server.handleWebhook
	// by importing and calling it directly

	it("should ignore isFromMe messages", () => {
		const processMessage = vi.fn();

		const server = createBlueServer({
			port: 0,
			agent: { processMessage },
		});

		server.handleWebhook(makePayload({ isFromMe: true }));
		expect(processMessage).not.toHaveBeenCalled();
	});

	it("should ignore messages without text", () => {
		const processMessage = vi.fn();

		const server = createBlueServer({
			port: 0,
			agent: { processMessage },
		});

		server.handleWebhook(makePayload({ text: null }));
		expect(processMessage).not.toHaveBeenCalled();

		server.handleWebhook(makePayload({ text: "  " }));
		expect(processMessage).not.toHaveBeenCalled();
	});

	it("should ignore non new-message events", () => {
		const processMessage = vi.fn();

		const server = createBlueServer({
			port: 0,
			agent: { processMessage },
		});

		server.handleWebhook({ type: "updated-message", data: makePayload().data });
		expect(processMessage).not.toHaveBeenCalled();
	});

	it("should dispatch valid messages to agent", async () => {
		const processMessage = vi.fn().mockResolvedValue(undefined);

		const server = createBlueServer({
			port: 0,
			agent: { processMessage },
		});

		server.handleWebhook(makePayload());

		// processMessage is called async (fire-and-forget), give it a tick
		await new Promise((r) => setTimeout(r, 10));
		expect(processMessage).toHaveBeenCalledWith("any;-;+1234567890", "hello blue");
	});
});

describe("bb client", () => {
	it("should construct proper API calls", () => {
		const client = createBBClient({ url: "http://localhost:1234", password: "test123" });

		// We can't test actual API calls without a server,
		// but we can verify the client is created without errors
		expect(client).toBeDefined();
		expect(client.sendMessage).toBeInstanceOf(Function);
		expect(client.sendTypingIndicator).toBeInstanceOf(Function);
		expect(client.sendReaction).toBeInstanceOf(Function);
	});
});
