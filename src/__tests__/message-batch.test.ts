import { describe, expect, it, vi } from "vitest";
import { createMessageBatchQueue, joinTextBatch } from "../message-batch.js";
import type { IncomingMessage } from "../types.js";

function message(text: string | null, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		chatGuid: "group-a",
		sender: "alice",
		text,
		messageType: "group",
		groupName: "Test",
		replyToText: null,
		attachments: [],
		images: [],
		...overrides,
	};
}

function fixture() {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const seen: IncomingMessage[][] = [];
	const queue = createMessageBatchQueue(async (batch) => {
		seen.push(batch);
		if (batch[0].text === "busy") await gate;
	});
	queue.enqueue(message("busy"));
	return { queue, seen, release };
}

function texts(seen: IncomingMessage[][]) {
	return seen.map((batch) => batch.map((item) => item.text));
}

describe("busy-only text batching", () => {
	it("starts idle work synchronously, without a debounce window", () => {
		const { seen, release } = fixture();
		expect(texts(seen)).toEqual([["busy"]]);
		release();
	});

	it("does not extend the active turn; joins only pending messages", async () => {
		const { queue, seen, release } = fixture();
		queue.enqueue(message("one"));
		queue.enqueue(message("two"));
		expect(texts(seen)).toEqual([["busy"]]);
		release();
		await vi.waitFor(() => expect(texts(seen)).toEqual([["busy"], ["one", "two"]]));
	});

	it("does not merge across a different speaker", async () => {
		const { queue, seen, release } = fixture();
		queue.enqueue(message("a1"));
		queue.enqueue(message("a2"));
		queue.enqueue(message("b1", { sender: "bob" }));
		queue.enqueue(message("a3"));
		release();
		await vi.waitFor(() => expect(texts(seen)).toEqual([["busy"], ["a1", "a2"], ["b1"], ["a3"]]));
	});

	it("runs other chats concurrently and releases idle chat state", async () => {
		const { queue, seen, release } = fixture();
		queue.enqueue(message("other", { chatGuid: "group-b" }));
		expect(texts(seen)).toEqual([["busy"], ["other"]]);
		await Promise.resolve();
		queue.enqueue(message("other-again", { chatGuid: "group-b" }));
		expect(texts(seen)).toEqual([["busy"], ["other"], ["other-again"]]);
		release();
	});

	it.each([
		["command", message("  /new")],
		["unknown slash command", message("/future-command")],
		["quote", message("quoted", { replyToText: "earlier text" })],
		["attachment", message(null, { attachments: [{ path: "/fixture/image.png", mimeType: "image/png" }] })],
		["loaded image", message("image", { images: [{ type: "image", data: "AA==", mimeType: "image/png" }] })],
		["blank text", message(" ")],
		["unknown sender", message("unknown", { sender: "" })],
		["renamed group", message("renamed", { groupName: "Renamed" })],
		["different service", message("sms", { messageType: "sms" })],
	])("keeps %s as a standalone boundary", async (_name, middle) => {
		const { queue, seen, release } = fixture();
		queue.enqueue(message("before"));
		queue.enqueue(middle);
		queue.enqueue(message("after"));
		release();
		await vi.waitFor(() => expect(seen).toHaveLength(4));
		expect(seen[1]).toEqual([message("before")]);
		expect(seen[2]).toEqual([middle]);
		expect(seen[3]).toEqual([message("after")]);
	});

	it("caps batches at eight messages without losing input", async () => {
		const { queue, seen, release } = fixture();
		for (let i = 0; i < 10; i++) queue.enqueue(message(String(i)));
		release();
		await vi.waitFor(() => expect(seen).toHaveLength(3));
		expect(seen.map((batch) => batch.length)).toEqual([1, 8, 2]);
		expect(texts(seen).flat()).toEqual(["busy", ...Array.from({ length: 10 }, (_, i) => String(i))]);
	});

	it("caps merged text size but never truncates an individual long message", async () => {
		const { queue, seen, release } = fixture();
		queue.enqueue(message("a".repeat(3999)));
		queue.enqueue(message("b".repeat(3999)));
		queue.enqueue(message("c"));
		queue.enqueue(message("d".repeat(9000)));
		release();
		await vi.waitFor(() => expect(seen).toHaveLength(4));
		expect(seen.map((batch) => batch.length)).toEqual([1, 2, 1, 1]);
		expect(joinTextBatch(seen[1]).text).toHaveLength(8000);
		expect(seen[3][0].text).toHaveLength(9000);
	});

	it("preserves the boundary of a bypassed stop command", async () => {
		const { queue, seen, release } = fixture();
		queue.enqueue(message("before-stop"));
		queue.boundary("group-a");
		queue.enqueue(message("after-stop"));
		release();
		await vi.waitFor(() => expect(texts(seen)).toEqual([["busy"], ["before-stop"], ["after-stop"]]));
	});

	it("continues after a failed batch without automatically replaying it", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const process = vi.fn().mockRejectedValueOnce(new Error("failure")).mockResolvedValue(undefined);
		const queue = createMessageBatchQueue(process);
		queue.enqueue(message("fails"));
		queue.enqueue(message("next"));
		await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2));
		expect(log).toHaveBeenCalledOnce();
		log.mockRestore();
	});

	it("preserves exact text and metadata, without mutating the originals", () => {
		const a = message(" first\nline ");
		const b = message("second");
		expect(joinTextBatch([a, b])).toEqual({ ...a, text: " first\nline \n\nsecond" });
		expect(a.text).toBe(" first\nline ");
		expect(b.text).toBe("second");
		expect(joinTextBatch([a])).toBe(a);
		expect(() => joinTextBatch([a, message("b", { sender: "bob" })])).toThrow("boundary");
		expect(() => joinTextBatch([a, message("/new")])).toThrow("boundary");
		expect(() => joinTextBatch([])).toThrow("empty");
	});
});
