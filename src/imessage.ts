/**
 * iMessage bot — pulls IncomingMessage objects from a queue (fed by the
 * watcher) and runs them through the pipeline (before → start → end).
 *
 *   watcher → queue → pipeline.process()
 *
 * Different chats run concurrently. Idle chats start immediately. While a
 * chat is busy, consecutive same-sender plain-text messages can be processed
 * as one turn. Commands, attachments, quotes, and sender changes split batches.
 */

import type { AgentManager } from "./agent.js";
import { goalCommand } from "./goal-compat.js";
import type { DigestLogger } from "./logger.js";
import { createMessageBatchQueue } from "./message-batch.js";
import { createMessagePipeline } from "./pipeline.js";
import { type AsyncQueue, QueueClosedError } from "./queue.js";
import type { SelfEchoFilter } from "./self-echo.js";
import type { MessageSender } from "./send.js";
import { isReplyEnabled } from "./settings.js";
import type { Settings } from "./settings.js";
import type { ChatStore } from "./store.js";
import {
	createArchiveImagesTask,
	createCallAgentTask,
	createCheckReplyEnabledTask,
	createCommandHandlerTask,
	createDownloadImagesTask,
	createDropSelfEchoTask,
	createLogIncomingTask,
	createLogOutgoingTask,
	createResizeImagesTask,
	createSendReplyTask,
	createStoreIncomingTask,
	createStoreOutgoingTask,
} from "./tasks.js";
import {
	type AgentReply,
	type ChatContext,
	type IncomingMessage,
	type OutgoingMessage,
	createOutgoingMessage,
} from "./types.js";

// ── iMessage bot ──────────────────────────────────────────────────────────────

export interface IMessageBotConfig {
	queue: AsyncQueue<IncomingMessage>;
	agent: AgentManager;
	sender: MessageSender;
	echoFilter: SelfEchoFilter;
	store: ChatStore;
	getSettings: () => Settings;
	digestLogger: DigestLogger;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { queue, agent, sender, echoFilter, store, getSettings, digestLogger } = config;
	const pipeline = createMessagePipeline();
	let running = false;
	const sendReply = createSendReplyTask(echoFilter, sender, getSettings);
	const logReply = createLogOutgoingTask(digestLogger);
	const storeReply = createStoreOutgoingTask(store);
	const enabled = (chatGuid: string) => running && isReplyEnabled(getSettings(), chatGuid);
	const waiting = new Map<string, number>();
	const hasQueuedInput = (chatGuid: string) => (waiting.get(chatGuid) ?? 0) > 0;
	const controlEpochs = new Map<string, number>();
	const chats = new Map<string, ChatContext>();

	// ── Pipeline tasks ─────────────────────────────────────────────────────────
	//
	//   before -> start ──┬── yield reply -> end
	//                     ├── yield reply -> end
	//                     └── ...done

	// before
	pipeline.before(createLogIncomingTask(digestLogger));
	pipeline.before(createDropSelfEchoTask(echoFilter));
	pipeline.before(createArchiveImagesTask(store));
	pipeline.before(createStoreIncomingTask(store));
	pipeline.before(createCheckReplyEnabledTask(getSettings));
	pipeline.before(createDownloadImagesTask());
	pipeline.before(createResizeImagesTask());

	// start: fence delayed lifecycle replies when a newer mutating command is admitted.
	pipeline.start(async (chat, incoming, outgoing) => {
		chats.set(chat.chatGuid, chat);
		const command = incoming.text?.trim() ?? "";
		const goal = goalCommand(command);
		if (/^\/(stop|new|reload)$/.test(command) || goal) {
			if (!goal || !["goal-status", "goal-list"].includes(goal.name))
				controlEpochs.set(chat.chatGuid, (controlEpochs.get(chat.chatGuid) ?? 0) + 1);
			const epoch = controlEpochs.get(chat.chatGuid);
			outgoing.isCurrent = () => enabled(chat.chatGuid) && controlEpochs.get(chat.chatGuid) === epoch;
		}
	});
	pipeline.start(createCommandHandlerTask(agent, hasQueuedInput));
	pipeline.start(createCallAgentTask(agent, hasQueuedInput));

	// end
	pipeline.end(sendReply);
	pipeline.end(logReply);
	pipeline.end(storeReply);

	return {
		/** Native continuations retain the ordinary rich-text, log and store delivery path. */
		async deliverGoalReply(chatGuid: string, reply: AgentReply): Promise<void> {
			if (reply.kind !== "assistant") return;
			const chat = chats.get(chatGuid) ?? {
				chatGuid,
				messageType: chatGuid.includes(";+;")
					? ("group" as const)
					: chatGuid.startsWith("SMS;")
						? ("sms" as const)
						: ("imessage" as const),
				groupName: "",
			};
			let outgoing: OutgoingMessage = {
				...createOutgoingMessage(),
				isCurrent: reply.isCurrent,
				reply: { type: "message", text: reply.text },
			};
			for (const task of [sendReply, logReply, storeReply]) {
				if (!enabled(chatGuid) || outgoing.isCurrent?.() === false) return;
				outgoing = await task(chat, outgoing);
				if (!outgoing.shouldContinue) return;
			}
		},
		start() {
			running = true;
			const batches = createMessageBatchQueue(async (messages) => {
				const chatGuid = messages[0].chatGuid;
				const remaining = (waiting.get(chatGuid) ?? messages.length) - messages.length;
				if (remaining > 0) waiting.set(chatGuid, remaining);
				else waiting.delete(chatGuid);
				if (messages.length > 1) {
					console.log(`[batch] ${messages[0].chatGuid}: merged ${messages.length} pending text messages`);
				}
				try {
					await pipeline.processBatch(messages);
				} finally {
					// Ack whether processing succeeded or failed-closed: the batch queue does not
					// retry in-process, so leaving it unacked would replay forever across restarts.
					for (const message of messages) queue.ack(message);
				}
			});

			async function loop(): Promise<void> {
				while (true) {
					const msg = await queue.pull();

					// Preserve the current cancellation/admission pipeline and split batches.
					const command = msg.text?.trim();
					if (command === "/stop" || command === "/new" || command === "/reload" || goalCommand(command ?? "")) {
						batches.boundary(msg.chatGuid);
						let admit = () => {};
						const admission = new Promise<void>((resolve) => {
							admit = resolve;
						});
						// Keep preflight/fencing in input order, not SDK cancellation or send settlement.
						void pipeline.process(msg, admit).then(
							() => {
								queue.ack(msg);
								batches.wake(msg.chatGuid);
							},
							(error: unknown) => {
								// Control command settled (failed closed); do not replay it on restart.
								queue.ack(msg);
								console.error("[sid] control command settlement failed", error);
							}
						);
						await admission;
						console.log(
							`[sid] control admission finished: ${msg.chatGuid}; cancellation/delivery does not block queue`
						);
						continue;
					}

					waiting.set(msg.chatGuid, (waiting.get(msg.chatGuid) ?? 0) + 1);
					batches.enqueue(msg);
				}
			}

			loop().catch((error: unknown) => {
				if (error instanceof QueueClosedError) {
					console.log("[sid] Queue closed, consumer stopped");
				} else {
					console.error("[sid] Consumer crashed:", error);
				}
			});
		},
		stop() {
			running = false;
			queue.close();
		},
	};
}
