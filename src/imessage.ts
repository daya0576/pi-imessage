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
 * Message ordering: every pulled message is immediately dispatched to the
 * pipeline (fire-and-forget). Different chats run concurrently. For the
 * same chat, the agent's steering mode (streamingBehavior: "steer") handles
 * rapid messages: if the agent is mid-run, a new message interrupts it as
 * a steering prompt rather than queuing behind the previous run.
 */

import type { AgentManager } from "./agent.js";
import { createSelfEchoFilter } from "./bluebubble/index.js";
import { QueueClosedError } from "./bluebubble/index.js";
import type { BBClient, BBRawMessage, RawMessageQueue } from "./bluebubble/index.js";
import type { DigestLogger } from "./logger.js";
import { createMessagePipeline } from "./pipeline.js";
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

// ── iMessage bot ──────────────────────────────────────────────────────────────

export interface IMessageBotConfig {
	queue: RawMessageQueue;
	agent: AgentManager;
	blueBubblesClient: BBClient;
	store: ChatStore;
	getSettings: () => Settings;
	digestLogger: DigestLogger;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { queue, agent, blueBubblesClient, store, getSettings, digestLogger } = config;
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
	pipeline.before(createDownloadImagesTask(blueBubblesClient));
	pipeline.before(createResizeImagesTask());

	// start
	pipeline.start(createCommandHandlerTask(agent));
	pipeline.start(createCallAgentTask(agent));

	// end
	pipeline.end(createSendReplyTask(echoFilter, blueBubblesClient));
	pipeline.end(createLogOutgoingTask(digestLogger));
	pipeline.end(createStoreOutgoingTask(store));

	return {
		start() {
			async function loop(): Promise<void> {
				while (true) {
					const raw = await queue.pull();
					const msg = assembleMessage(raw);

					// Fire-and-forget — steering handles same-guid concurrency:
					//
					//   pull msg(guid=A) → pipeline  (A starts)
					//   pull msg(guid=B) → pipeline  (B starts, A still running)
					//   pull msg(guid=A) → pipeline  (steers into A's running agent)
					pipeline.process(msg).catch((error: unknown) => {
						const sender = raw.handle?.address ?? "unknown";
						console.error(`[sid] failed to process message from ${sender}:`, error);
					});
				}
			}

			loop().catch((error: unknown) => {
				if (error instanceof QueueClosedError) {
					console.log("[sid] Message queue closed, consumer stopped");
				} else {
					console.error("[sid] Message consumer crashed:", error);
				}
			});
		},
		stop() {
			queue.close();
		},
	};
}
