import { describe, expect, it, vi } from "vitest";
import type { AgentManager, ProcessMessageOptions } from "../agent.js";
import { createIMessageBot } from "../imessage.js";
import type { DigestLogger } from "../logger.js";
import { createAsyncQueue } from "../queue.js";
import { createSelfEchoFilter } from "../self-echo.js";
import type { MessageSender } from "../send.js";
import type { ChatStore } from "../store.js";
import type { AgentReply, IncomingMessage } from "../types.js";

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
	it("admits native goal controls while busy and retains ordinary goal reply formatting, logs and storage", async () => {
		const queue = createAsyncQueue<IncomingMessage>();
		let finish = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const processMessage = vi.fn(
			async (
				incoming: IncomingMessage,
				handler: (reply: AgentReply) => Promise<void>,
				options?: ProcessMessageOptions
			) => {
				options?.onAdmitted?.();
				if (incoming.text === "busy") await gate;
				else await handler({ kind: "assistant", text: "Native status" });
			}
		);
		const sendMessage = vi.fn(async () => {});
		const log = vi.fn(async () => {});
		const digest = vi.fn();
		let enabled = true;
		const richText = { enabled: true, markdown: false };
		const bot = createIMessageBot({
			queue,
			agent: { processMessage } as unknown as AgentManager,
			echoFilter: createSelfEchoFilter(),
			sender: { sendMessage } as unknown as MessageSender,
			store: { archiveImages: async () => [], log } as unknown as ChatStore,
			digestLogger: { log: digest, close: () => {} },
			getSettings: () => ({ chatAllowlist: { whitelist: enabled ? ["*"] : [], blacklist: [] }, richText }),
		});
		bot.start();
		try {
			queue.push({ ...message, text: "busy" });
			await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(1));
			queue.push({ ...message, text: "/goal status" });
			queue.push({ ...message, text: "/goal pause" });
			await vi.waitFor(() => expect(processMessage).toHaveBeenCalledTimes(3));
			expect(processMessage.mock.calls.map(([incoming]) => incoming.text)).toEqual([
				"busy",
				"/goal status",
				"/goal pause",
			]);
			const before = sendMessage.mock.calls.length;
			await bot.deliverGoalReply(message.chatGuid, { kind: "assistant", text: "Goal result", isCurrent: () => false });
			expect(sendMessage).toHaveBeenCalledTimes(before);
			await bot.deliverGoalReply(message.chatGuid, { kind: "assistant", text: "Goal result" });
			expect(sendMessage).toHaveBeenLastCalledWith(message.chatGuid, "Goal result", richText);
			expect(digest).toHaveBeenLastCalledWith(expect.stringContaining("Goal result"));
			expect(log).toHaveBeenLastCalledWith(
				message.chatGuid,
				expect.objectContaining({ fromAgent: true, text: "Goal result" })
			);
			enabled = false;
			await bot.deliverGoalReply(message.chatGuid, { kind: "assistant", text: "Disabled result" });
			expect(sendMessage).toHaveBeenCalledTimes(before + 1);
		} finally {
			finish();
			bot.stop();
		}
	});
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
