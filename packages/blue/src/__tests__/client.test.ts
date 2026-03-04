import { describe, expect, it } from "vitest";
import { createBBClient } from "../bluebubble/index.js";

// ── BB client ─────────────────────────────────────────────────────────────────

describe("bb client", () => {
	it("creates client with expected methods", () => {
		const client = createBBClient({ url: "http://localhost:1234", password: "test123" });
		expect(client.sendMessage).toBeInstanceOf(Function);
		expect(client.sendTypingIndicator).toBeInstanceOf(Function);
		expect(client.sendReaction).toBeInstanceOf(Function);
	});
});
