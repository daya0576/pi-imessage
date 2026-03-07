/**
 * iMessage bot — pulls raw BlueBubbles messages from an externally managed
 * queue, assembles them into unified IncomingMessage objects, and runs them
 * through the message pipeline (before → start → end).
 *
 *   queue.subscribe() → assembleMessage() → pipeline.process()
 *
 * The queue is created and owned by the caller (main.ts), which also creates
 * the monitor that pushes into it. This keeps imessage.ts fully decoupled
 * from monitor.ts — neither imports the other.
 *
 * Message ordering: assembly + pipeline execution is serialised through a
 * promise chain so messages reach the agent in webhook-arrival order.
 */

import type { AgentManager } from "./agent.js";
import { createSelfEchoFilter } from "./bluebubble/index.js";
import { QueueClosedError } from "./bluebubble/index.js";
import type { BBClient, BBRawMessage, RawMessageQueue } from "./bluebubble/index.js";
import { createMessagePipeline } from "./pipeline.js";
import type { Settings } from "./settings.js";
import type { ChatStore } from "./store.js";
import {
	createCallAgentTask,
	createCheckReplyEnabledTask,
	createDownloadImagesTask,
	createDropSelfEchoTask,
	createLogIncomingTask,
	createLogOutgoingTask,
	createSendReplyTask,
	createStoreIncomingTask,
	createStoreOutgoingTask,
} from "./tasks.js";
import type { IncomingMessage, MessageType } from "./types.js";

// ── Raw → unified assembly ────────────────────────────────────────────────────

/**
 * Derive the MessageType from the handle service and chatGuid structure:
 *   SMS service        → "sms"
 *   iMessage + ";-;"   → "imessage" (direct message)
 *   iMessage + ";+;"   → "group"    (group chat)
 */
function deriveMessageType(raw: BBRawMessage, chatGuid: string): MessageType {
	const service = raw.handle?.service ?? "iMessage";
	if (service === "SMS") return "sms";
	return chatGuid.split(";")[1] === "+" ? "group" : "imessage";
}

/**
 * Assemble a raw BlueBubbles message into a unified IncomingMessage.
 * Raw attachments are carried through for the downloadImages pipeline task;
 * images[] starts empty and is populated during the start phase.
 */
export function assembleMessage(raw: BBRawMessage): IncomingMessage {
	const chatGuid = raw.chats[0].guid;
	const messageType = deriveMessageType(raw, chatGuid);
	const text = raw.text?.trim() ?? null;
	const sender = raw.handle?.address ?? "unknown";
	const groupName = raw.chats[0].displayName ?? "";
	const attachments = raw.attachments ?? [];
	return { chatGuid, text, sender, messageType, groupName, attachments, images: [] };
}

// ── Per-guid serial queue ─────────────────────────────────────────────────────

/** Queues async tasks and runs them one at a time in submission order. */
function createSerialQueue() {
	let tail = Promise.resolve();
	return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = tail.then(fn);
		tail = result.then(() => {}, () => {}); // swallow errors so the queue always advances
		return result;
	};
}

type SerialQueue = ReturnType<typeof createSerialQueue>;

// ── iMessage bot ──────────────────────────────────────────────────────────────

export interface IMessageBotConfig {
	queue: RawMessageQueue;
	agent: AgentManager;
	blueBubblesClient: BBClient;
	store: ChatStore;
	getSettings: () => Settings;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { queue, agent, blueBubblesClient, store, getSettings } = config;
	const echoFilter = createSelfEchoFilter();
	const pipeline = createMessagePipeline();

	// ── Pipeline tasks ─────────────────────────────────────────────────────────
	//
	//   before -> start ──┬── yield reply -> end 
	//                     ├── yield reply -> end
	//                     └── ...done

	// before
	pipeline.before(createLogIncomingTask());
	pipeline.before(createDropSelfEchoTask(echoFilter));
	pipeline.before(createStoreIncomingTask(store));
	pipeline.before(createCheckReplyEnabledTask(getSettings));
	pipeline.before(createDownloadImagesTask(blueBubblesClient));

	// start
	pipeline.start(createCallAgentTask(agent));

	// end
	pipeline.end(createSendReplyTask(echoFilter, blueBubblesClient));
	pipeline.end(createLogOutgoingTask());
	pipeline.end(createStoreOutgoingTask(store));

	return {
		start() {
			const guidQueues = new Map<string, SerialQueue>();

			function getOrCreateGuidQueue(chatGuid: string): SerialQueue {
				let guidQueue = guidQueues.get(chatGuid);
				if (!guidQueue) {
					guidQueue = createSerialQueue();
					guidQueues.set(chatGuid, guidQueue);
				}
				return guidQueue;
			}

			async function loop(): Promise<void> {
				while (true) {
					const raw = await queue.pull();
					const msg = assembleMessage(raw);
					const guidQueue = getOrCreateGuidQueue(msg.chatGuid);

					// Enqueue: same guid runs serially, different guids run concurrently.
					//
					//   pull msg(guid=A) → enqueue to A's queue  (A starts immediately)
					//   pull msg(guid=B) → enqueue to B's queue  (B starts immediately, A still running)
					//   pull msg(guid=A) → enqueue to A's queue  (waits for previous A to finish)
					//
					guidQueue(() => pipeline.process(msg)).catch((error: unknown) => {
						const sender = raw.handle?.address ?? "unknown";
						console.error(`[blue] failed to process message from ${sender}:`, error);
					});
				}
			}

			loop().catch((error: unknown) => {
				if (error instanceof QueueClosedError) {
					console.log("[blue] Message queue closed, consumer stopped");
				} else {
					console.error("[blue] Message consumer crashed:", error);
				}
			});
		},
		stop() {
			queue.close();
		},
	};
}
