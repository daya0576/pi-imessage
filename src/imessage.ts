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
import type { DigestLogger } from "./logger.js";
import { createMessageBatchQueue } from "./message-batch.js";
import { createMessagePipeline } from "./pipeline.js";
import { type AsyncQueue, QueueClosedError } from "./queue.js";
import type { SelfEchoFilter } from "./self-echo.js";
import type { MessageSender } from "./send.js";
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
import type { IncomingMessage } from "./types.js";

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
	const waiting = new Map<string, number>();
	const hasQueuedInput = (chatGuid: string) => (waiting.get(chatGuid) ?? 0) > 0;

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

	// start
	pipeline.start(createCommandHandlerTask(agent, hasQueuedInput));
	pipeline.start(createCallAgentTask(agent, hasQueuedInput));

	// end
	pipeline.end(createSendReplyTask(echoFilter, sender, getSettings));
	pipeline.end(createLogOutgoingTask(digestLogger));
	pipeline.end(createStoreOutgoingTask(store));

	return {
		start() {
			const batches = createMessageBatchQueue(async (messages) => {
				const chatGuid = messages[0].chatGuid;
				const remaining = (waiting.get(chatGuid) ?? messages.length) - messages.length;
				if (remaining > 0) waiting.set(chatGuid, remaining);
				else waiting.delete(chatGuid);
				if (messages.length > 1) {
					console.log(`[batch] ${messages[0].chatGuid}: merged ${messages.length} pending text messages`);
				}
				await pipeline.processBatch(messages);
			});

			async function loop(): Promise<void> {
				while (true) {
					const msg = await queue.pull();

					// Preserve the current cancellation/admission pipeline and split batches.
					const command = msg.text?.trim();
					if (command === "/stop" || command === "/new") {
						batches.boundary(msg.chatGuid);
						try {
							await pipeline.process(msg);
						} catch (error) {
							console.error("[sid] cancellation command failed in pipeline", error);
						}
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
			queue.close();
		},
	};
}
