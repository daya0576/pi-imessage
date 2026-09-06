import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent.js";
import { createIMessageBot } from "../imessage.js";
import { createMessagePipeline } from "../pipeline.js";
import { createAsyncQueue } from "../queue.js";
import { createSelfEchoFilter } from "../self-echo.js";
import type { MessageSender } from "../send.js";
import type { ChatStore } from "../store.js";
import type { AgentReply, IncomingMessage } from "../types.js";

function message(text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		chatGuid: "test-group",
		sender: "alice",
		text,
		messageType: "group",
		groupName: "Fixture",
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
	const processMessage = vi.fn(async (incoming: IncomingMessage, reply: (r: AgentReply) => Promise<void>) => {
		if (incoming.text === "busy") await gate;
		await reply({ kind: "assistant", text: `reply:${incoming.text}` });
	});
	const stop = vi.fn(async () => {});
	const agent = {
		processMessage,
		stop,
		newSession: vi.fn(async () => {}),
		getSessionStatus: vi.fn(async () => "status"),
	};
	const store = { archiveImages: vi.fn(async () => []), log: vi.fn(async () => {}) };
	const sender = { sendMessage: vi.fn(async () => {}), sendAttachment: vi.fn(async () => {}) };
	const echoFilter = createSelfEchoFilter();
	const queue = createAsyncQueue<IncomingMessage>();
	const settings = { chatAllowlist: { whitelist: ["*"], blacklist: [] as string[] } };
	const log = vi.fn();
	const bot = createIMessageBot({
		queue,
		agent: agent as unknown as AgentManager,
		sender: sender as unknown as MessageSender,
		store: store as unknown as ChatStore,
		echoFilter,
		getSettings: () => settings,
		digestLogger: { log, close() {} },
	});
	bot.start();
	queue.push(message("busy"));
	return { queue, bot, processMessage, stop, agent, store, sender, echoFilter, release, settings, log };
}

async function waitForPulls() {
	// Allow the actual consumer to transfer pending inputs to its per-chat queue.
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("actual bot pipeline with busy batching", () => {
	it("stores each source once, filters echoes separately, and sends one joined turn", async () => {
		const f = fixture();
		try {
			await vi.waitFor(() => expect(f.processMessage).toHaveBeenCalledTimes(1));
			f.echoFilter.remember("test-group", "echo");
			f.queue.push(message("one"));
			f.queue.push(message("echo"));
			f.queue.push(message("two"));
			await waitForPulls();
			expect(f.processMessage).toHaveBeenCalledTimes(1);
			f.release();
			await vi.waitFor(() => expect(f.sender.sendMessage).toHaveBeenCalledTimes(2));
			expect(f.processMessage.mock.calls.map(([m]) => m.text)).toEqual(["busy", "one\n\ntwo"]);
			const originals = f.store.log.mock.calls as unknown as [string, { fromAgent: boolean; text: string }][];
			expect(originals.filter(([, e]) => !e.fromAgent).map(([, e]) => e.text)).toEqual(["busy", "one", "two"]);
			expect(f.log.mock.calls.filter(([line]) => String(line).includes("<-"))).toHaveLength(4);
		} finally {
			f.release();
			f.bot.stop();
		}
	});

	it("executes /new alone between the surrounding text turns", async () => {
		const f = fixture();
		try {
			await vi.waitFor(() => expect(f.processMessage).toHaveBeenCalledTimes(1));
			f.queue.push(message("before"));
			f.queue.push(message("/new"));
			f.queue.push(message("after"));
			await waitForPulls();
			f.release();
			await vi.waitFor(() => expect(f.sender.sendMessage).toHaveBeenCalledTimes(5));
			expect(f.agent.newSession).toHaveBeenCalledOnce();
			expect(f.processMessage.mock.calls.map(([m]) => m.text)).toEqual(["busy", "before", "after"]);
		} finally {
			f.release();
			f.bot.stop();
		}
	});

	it("keeps /stop immediate and prevents merging text from either side of it", async () => {
		const f = fixture();
		try {
			await vi.waitFor(() => expect(f.processMessage).toHaveBeenCalledTimes(1));
			f.queue.push(message("before-stop"));
			f.queue.push(message("/stop"));
			f.queue.push(message("after-stop"));
			await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
			await waitForPulls();
			expect(f.processMessage).toHaveBeenCalledTimes(1);
			f.release();
			await vi.waitFor(() => expect(f.sender.sendMessage).toHaveBeenCalledTimes(4));
			expect(f.processMessage.mock.calls.map(([m]) => m.text)).toEqual(["busy", "before-stop", "after-stop"]);
		} finally {
			f.release();
			f.bot.stop();
		}
	});

	it("preserves log-only settings for every pending source", async () => {
		const f = fixture();
		try {
			await vi.waitFor(() => expect(f.processMessage).toHaveBeenCalledTimes(1));
			f.queue.push(message("one"));
			f.queue.push(message("two"));
			await waitForPulls();
			f.settings.chatAllowlist.blacklist.push("test-group");
			f.release();
			await vi.waitFor(() => expect(f.store.log).toHaveBeenCalledTimes(4));
			expect(f.processMessage).toHaveBeenCalledTimes(1);
		} finally {
			f.release();
			f.bot.stop();
		}
	});
});

describe("batch preparation", () => {
	it("isolates a preparation failure without discarding the other source messages", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const pipeline = createMessagePipeline();
		const observed: string[] = [];
		pipeline.before((_chat, incoming, outgoing) => {
			observed.push(incoming.text ?? "");
			if (incoming.text === "bad") throw new Error("fixture preparation failure");
			return outgoing;
		});
		const start = vi.fn(async () => {});
		pipeline.start(start);
		try {
			await pipeline.processBatch([message("one"), message("bad"), message("two")]);
			expect(observed).toEqual(["one", "bad", "two"]);
			expect(start).toHaveBeenCalledOnce();
			expect(start.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ text: "one\n\ntwo" })]));
			expect(errors).toHaveBeenCalledOnce();
		} finally {
			errors.mockRestore();
		}
	});

	it("does not call the agent when all originals are filtered out", async () => {
		const pipeline = createMessagePipeline();
		pipeline.before((_chat, _incoming, outgoing) => ({ ...outgoing, shouldContinue: false }));
		const start = vi.fn(async () => {});
		pipeline.start(start);
		await pipeline.processBatch([message("one"), message("two")]);
		expect(start).not.toHaveBeenCalled();
	});

	it("rejects cross-sender batches before running even the logging tasks", async () => {
		const pipeline = createMessagePipeline();
		const before = vi.fn((_chat, _incoming, outgoing) => outgoing);
		pipeline.before(before);
		await expect(pipeline.processBatch([message("one"), message("two", { sender: "bob" })])).rejects.toThrow(
			"boundary"
		);
		expect(before).not.toHaveBeenCalled();
	});
});
