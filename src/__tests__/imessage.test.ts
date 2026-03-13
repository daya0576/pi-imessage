import { describe, expect, it, vi } from "vitest";
import { createSelfEchoFilter } from "../self-echo.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CHAT_DM = "iMessage;-;+1111111111";

// ── self-echo integration ─────────────────────────────────────────────────────

describe("iMessage bot integration", () => {
	it("self-chat: bot reply echo is suppressed via echoFilter", async () => {
		const echoFilter = createSelfEchoFilter();
		const processMessage = vi.fn().mockResolvedValue("pong");

		// Simulate: user sends "hello", bot replies "pong"
		const reply = await processMessage({ chatGuid: CHAT_DM, text: "hello" });
		echoFilter.remember(CHAT_DM, reply);

		// Echo of bot's reply arrives as incoming
		expect(echoFilter.isEcho(CHAT_DM, "pong")).toBe(true);
		expect(processMessage).toHaveBeenCalledTimes(1);
	});
});
