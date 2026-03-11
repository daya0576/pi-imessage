import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBBClient } from "../bluebubble/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_URL = "http://bb.local:1234";
const PASSWORD = "secret";

function makeClient() {
	return createBBClient({ url: BASE_URL, password: PASSWORD });
}

/** Build a minimal fetch mock that returns the given status and body. */
function mockFetch(status: number, body: string) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		text: () => Promise.resolve(body),
	});
}

// ── bb client ─────────────────────────────────────────────────────────────────

describe("bb client", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	// ── sendMessage ───────────────────────────────────────────────────────────

	describe("sendMessage", () => {
		it("POSTs to the correct endpoint with chatGuid and message", async () => {
			const fetchMock = mockFetch(200, "{}");
			vi.stubGlobal("fetch", fetchMock);

			await makeClient().sendMessage("iMessage;-;+1234567890", "hello");

			const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(calledUrl).toMatch(`${BASE_URL}/api/v1/message/text`);
			expect(calledUrl).toContain(`password=${PASSWORD}`);
			expect(calledInit.method).toBe("POST");

			const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
			expect(body.chatGuid).toBe("iMessage;-;+1234567890");
			expect(body.message).toBe("hello");
			expect(typeof body.tempGuid).toBe("string");
		});

		it("resolves without error on 200", async () => {
			vi.stubGlobal("fetch", mockFetch(200, JSON.stringify({ status: "ok" })));
			await expect(makeClient().sendMessage("chat", "hi")).resolves.toBeUndefined();
		});

		it("throws on non-ok HTTP response (4xx)", async () => {
			vi.stubGlobal("fetch", mockFetch(400, "bad request"));
			await expect(makeClient().sendMessage("chat", "hi")).rejects.toThrow("400");
		});

		it("throws on non-ok HTTP response (5xx)", async () => {
			vi.stubGlobal("fetch", mockFetch(500, "internal server error"));
			await expect(makeClient().sendMessage("chat", "hi")).rejects.toThrow("500");
		});

		it("throws on request timeout", async () => {
			const fetchMock = vi.fn().mockImplementation(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						(init.signal as AbortSignal).addEventListener("abort", () => {
							const err = new Error("aborted");
							err.name = "AbortError";
							reject(err);
						});
					})
			);
			vi.stubGlobal("fetch", fetchMock);

			const promise = makeClient().sendMessage("chat", "hi");
			// Attach the rejection handler before advancing the clock to avoid
			// a temporary unhandled-rejection warning.
			const assertion = expect(promise).rejects.toThrow("aborted");
			await vi.advanceTimersByTimeAsync(10_001);
			await assertion;
		});
	});

	// ── sendTypingIndicator ───────────────────────────────────────────────────

	describe("sendTypingIndicator", () => {
		it("POSTs to the correct chat typing endpoint", async () => {
			const fetchMock = mockFetch(200, "{}");
			vi.stubGlobal("fetch", fetchMock);

			await makeClient().sendTypingIndicator("iMessage;-;+1234567890");

			const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(calledUrl).toContain("/chat/");
			expect(calledUrl).toContain("/typing");
		});

		it("does not throw when the request fails", async () => {
			vi.stubGlobal("fetch", mockFetch(500, "error"));
			await expect(makeClient().sendTypingIndicator("chat")).resolves.toBeUndefined();
		});
	});

	// ── sendReaction ──────────────────────────────────────────────────────────

	describe("sendReaction", () => {
		it("POSTs to /message/react with correct fields", async () => {
			const fetchMock = mockFetch(200, "{}");
			vi.stubGlobal("fetch", fetchMock);

			await makeClient().sendReaction("iMessage;-;+1234567890", "msg-guid-123", "love");

			const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(calledUrl).toContain("/message/react");
			const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
			expect(body.chatGuid).toBe("iMessage;-;+1234567890");
			expect(body.selectedMessageGuid).toBe("msg-guid-123");
			expect(body.reaction).toBe("love");
		});

		it("throws on non-ok response", async () => {
			vi.stubGlobal("fetch", mockFetch(403, "forbidden"));
			await expect(makeClient().sendReaction("chat", "msg", "like")).rejects.toThrow("403");
		});
	});

	// ── response parsing ──────────────────────────────────────────────────────

	describe("response parsing", () => {
		it("returns parsed JSON on success", async () => {
			vi.stubGlobal("fetch", mockFetch(200, '{"data":"ok"}'));
			// sendMessage returns void, so we verify no error is thrown (parsing is internal)
			await expect(makeClient().sendMessage("chat", "hi")).resolves.toBeUndefined();
		});

		it("falls back to raw text when response is not valid JSON", async () => {
			vi.stubGlobal("fetch", mockFetch(200, "plain text response"));
			await expect(makeClient().sendMessage("chat", "hi")).resolves.toBeUndefined();
		});
	});
});
