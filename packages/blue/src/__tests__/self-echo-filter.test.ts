import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelfEchoFilter } from "../bluebubble/index.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CHAT_A = "iMessage;-;+1111111111";
const CHAT_B = "iMessage;-;+2222222222";

// ── self-echo filter (unit) ───────────────────────────────────────────────────

describe("createSelfEchoFilter", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("returns false before any message is registered", () => {
		const filter = createSelfEchoFilter();
		expect(filter.isEcho(CHAT_A, "hello")).toBe(false);
	});

	it("detects an echo of a remembered message in the same chat", () => {
		const filter = createSelfEchoFilter();
		filter.remember(CHAT_A, "bot reply");
		expect(filter.isEcho(CHAT_A, "bot reply")).toBe(true);
	});

	it("does not suppress echo from a different chat", () => {
		const filter = createSelfEchoFilter();
		filter.remember(CHAT_A, "bot reply");
		expect(filter.isEcho(CHAT_B, "bot reply")).toBe(false);
	});

	it("consumes the entry — identical human follow-up is not suppressed", () => {
		const filter = createSelfEchoFilter();
		filter.remember(CHAT_A, "bot reply");
		expect(filter.isEcho(CHAT_A, "bot reply")).toBe(true);  // echo: consumed
		expect(filter.isEcho(CHAT_A, "bot reply")).toBe(false); // human follow-up: allowed
	});

	it("matching is case-insensitive and trims whitespace", () => {
		const filter = createSelfEchoFilter();
		filter.remember(CHAT_A, "  Hello World  ");
		expect(filter.isEcho(CHAT_A, "hello world")).toBe(true);
	});

	it("allows the same text after TTL expires", () => {
		const filter = createSelfEchoFilter(60_000);
		filter.remember(CHAT_A, "bot reply");
		vi.advanceTimersByTime(61_000);
		expect(filter.isEcho(CHAT_A, "bot reply")).toBe(false);
	});

	it("does not expire entries before TTL", () => {
		const filter = createSelfEchoFilter(60_000);
		filter.remember(CHAT_A, "bot reply");
		vi.advanceTimersByTime(59_000);
		expect(filter.isEcho(CHAT_A, "bot reply")).toBe(true);
	});

	it("handles multiple chats independently", () => {
		const filter = createSelfEchoFilter();
		filter.remember(CHAT_A, "reply A");
		filter.remember(CHAT_B, "reply B");
		expect(filter.isEcho(CHAT_A, "reply B")).toBe(false);
		expect(filter.isEcho(CHAT_B, "reply A")).toBe(false);
		expect(filter.isEcho(CHAT_A, "reply A")).toBe(true);
		expect(filter.isEcho(CHAT_B, "reply B")).toBe(true);
	});
});
