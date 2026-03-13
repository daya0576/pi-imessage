/**
 * iMessage bot — pulls IncomingMessage objects from a queue (fed by the
 * watcher) and runs them through the pipeline (before → start → end).
 *
 *   watcher → queue → pipeline.process()
 *
 * Message ordering: every pulled message is immediately dispatched to the
 * pipeline (fire-and-forget). Different chats run concurrently. For the
 * same chat, the agent's steering mode (streamingBehavior: "steer") handles
 * rapid messages: if the agent is mid-run, a new message interrupts it as
 * a steering prompt rather than queuing behind the previous run.
 */

import type { AgentManager } from "./agent.js";
import type { DigestLogger } from "./logger.js";
import { createMessagePipeline } from "./pipeline.js";
import type { AsyncQueue } from "./queue.js";
import { QueueClosedError } from "./queue.js";
import { createSelfEchoFilter } from "./self-echo.js";
import type { MessageSender } from "./send.js";
import type { Settings } from "./settings.js";
import type { ChatStore } from "./store.js";
import {
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
	store: ChatStore;
	getSettings: () => Settings;
	digestLogger: DigestLogger;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { queue, agent, sender, store, getSettings, digestLogger } = config;
	const echoFilter = createSelfEchoFilter();
	const pipeline = createMessagePipeline();

	// ── Pipeline tasks ─────────────────────────────────────────────────────────
	//
	//   before -> start ──┬── yield reply -> end
	//                     ├── yield reply -> end
	//                     └── ...done

	// before
	pipeline.before(createLogIncomingTask(digestLogger));
	pipeline.before(createDropSelfEchoTask(echoFilter));
	pipeline.before(createStoreIncomingTask(store));
	pipeline.before(createCheckReplyEnabledTask(getSettings));
	pipeline.before(createDownloadImagesTask());
	pipeline.before(createResizeImagesTask());

	// start
	pipeline.start(createCommandHandlerTask(agent));
	pipeline.start(createCallAgentTask(agent));

	// end
	pipeline.end(createSendReplyTask(echoFilter, sender));
	pipeline.end(createLogOutgoingTask(digestLogger));
	pipeline.end(createStoreOutgoingTask(store));

	return {
		start() {
			async function loop(): Promise<void> {
				while (true) {
					const msg = await queue.pull();

					// Fire-and-forget — steering handles same-guid concurrency
					pipeline.process(msg).catch((error: unknown) => {
						console.error(`[sid] failed to process message from ${msg.sender}:`, error);
					});
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
