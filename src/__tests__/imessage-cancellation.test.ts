import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent.js";
import { createIMessageBot } from "../imessage.js";
import type { DigestLogger } from "../logger.js";
import { createAsyncQueue } from "../queue.js";
import { createSelfEchoFilter } from "../self-echo.js";
import type { MessageSender } from "../send.js";
import type { ChatStore } from "../store.js";
import type { IncomingMessage } from "../types.js";

const message: IncomingMessage = {
	chatGuid: "synthetic-chat",
	sender: "test",
	text: "/new",
	messageType: "imessage",
	groupName: "",
	replyToText: null,
	attachments: [],
	images: [],
};

describe("cancellation admission through the real bot consumer", () => {
	it("drops disabled and self-echo commands, but admits /stop without waiting for an active prompt", async () => {
		const queue = createAsyncQueue<IncomingMessage>();
		const echoFilter = createSelfEchoFilter();
		let finishPrompt = () => {};
		const promptGate = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});
		const processMessage = vi.fn(() => promptGate);
		const stop = vi.fn(async () => {});
		const newSession = vi.fn(async () => {});
		const sendMessage = vi.fn(async () => {});
		let enabled = false;
		const bot = createIMessageBot({
			queue,
			echoFilter,
			agent: { processMessage, stop, newSession } as unknown as AgentManager,
			sender: { sendMessage } as unknown as MessageSender,
			store: { archiveImages: async () => [], log: async () => {} } as unknown as ChatStore,
			digestLogger: { log: () => {}, close: () => {} } satisfies DigestLogger,
			getSettings: () => ({ chatAllowlist: { whitelist: enabled ? ["*"] : [], blacklist: [] } }),
		});
		bot.start();
		const drain = async () => {
			for (let step = 0; step < 100; step++) await Promise.resolve();
		};
		try {
			queue.push(message);
			queue.push({ ...message, text: "/stop" });
			await drain();
			expect(newSession).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
			enabled = true;
			echoFilter.remember(message.chatGuid, "/new");
			echoFilter.remember(message.chatGuid, "/stop");
			queue.push(message);
			queue.push({ ...message, text: "/stop" });
			await drain();
			expect(newSession).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
			queue.push({ ...message, text: "Synthetic foreground request" });
			await drain();
			expect(processMessage).toHaveBeenCalledTimes(1);
			// Echo entries are consumed on match; this is a newly admitted command.
			queue.push({ ...message, text: "/stop" });
			await drain();
			expect(stop).toHaveBeenCalledTimes(1);
			expect(sendMessage.mock.calls).toHaveLength(1);
		} finally {
			finishPrompt();
			bot.stop();
		}
	});
});
