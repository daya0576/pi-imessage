import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBBClient } from "../bluebubble/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_URL = "http://bb.local:1234";
const PASSWORD = "secret";

function makeClient() {
	return createBBClient({ url: BASE_URL, password: PASSWORD });
}

// ── bb client ─────────────────────────────────────────────────────────────────

describe("bb client", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	// ── downloadAttachmentBytes ───────────────────────────────────────────────

	describe("downloadAttachmentBytes", () => {
		it("GETs the correct attachment download endpoint", async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
			});
			vi.stubGlobal("fetch", fetchMock);

			await makeClient().downloadAttachmentBytes("attach-001");

			const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(calledUrl).toContain("/attachment/attach-001/download");
			expect(calledUrl).toContain(`password=${PASSWORD}`);
		});

		it("returns Buffer from response", async () => {
			const bytes = new Uint8Array([1, 2, 3, 4]);
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				arrayBuffer: () => Promise.resolve(bytes.buffer),
			});
			vi.stubGlobal("fetch", fetchMock);

			const result = await makeClient().downloadAttachmentBytes("attach-001");
			expect(Buffer.isBuffer(result)).toBe(true);
			expect(result.length).toBe(4);
		});

		it("throws on non-ok response", async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				text: () => Promise.resolve("not found"),
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(makeClient().downloadAttachmentBytes("attach-001")).rejects.toThrow("404");
		});
	});
});
