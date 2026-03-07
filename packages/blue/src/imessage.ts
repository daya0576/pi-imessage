/**
 * iMessage bot — pulls raw BlueBubbles messages from an externally managed
 * queue, assembles them into unified IncomingMessage objects, and runs them
 * through the message pipeline (before → start → end).
 *
 *   queue.pull() → assembleMessage() → pipeline.process()
 *
 * The queue is created and owned by the caller (main.ts), which also creates
 * the monitor that pushes into it. This keeps imessage.ts fully decoupled
 * from monitor.ts — neither imports the other.
 *
 * Pipeline tasks (registered in createIMessageBot):
 *   before : logIncoming, dropSelfEcho, storeIncoming, checkReplyEnabled
 *   start  : callAgent
 *   end    : sendReply, logOutgoing
 *
 * Message ordering: assembly + pipeline execution is serialised through a
 * promise chain so messages reach the agent in webhook-arrival order.
 */

import type { AgentManager } from "./agent.js";
import { QueueClosedError, createSelfEchoFilter } from "./bluebubble/index.js";
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

	// before
	pipeline.before(createLogIncomingTask());
	pipeline.before(createDropSelfEchoTask(echoFilter));
	pipeline.before(createStoreIncomingTask(store));
	pipeline.before(createCheckReplyEnabledTask(getSettings));

	// start
	pipeline.start(createDownloadImagesTask(blueBubblesClient));
	pipeline.start(createCallAgentTask(agent));

	// end
	pipeline.end(createSendReplyTask(echoFilter, blueBubblesClient));
	pipeline.end(createLogOutgoingTask());
	pipeline.end(createStoreOutgoingTask(store));

	// ── Consumer loop ──────────────────────────────────────────────────────────

	/**
	 * Serial promise chain that ensures messages are assembled and processed
	 * in webhook-arrival order, even when some messages require slow attachment
	 * downloads and others are plain text.
	 */
	let processChain: Promise<void> = Promise.resolve();

	async function consumeLoop(): Promise<void> {
		try {
			while (true) {
				const raw = await queue.pull();
				processChain = processChain
					.then(async () => {
						const msg = assembleMessage(raw);
						await pipeline.process(msg);
					})
					.catch((error) => {
						const sender = raw.handle?.address ?? "unknown";
						console.error(`[blue] failed to process message from ${sender}:`, error);
					});
			}
		} catch (error) {
			if (error instanceof QueueClosedError) {
				console.log("[blue] Consumer loop stopped (queue closed)");
				return;
			}
			throw error;
		}
	}

	return {
		start() {
			consumeLoop().catch((error) => {
				console.error("[blue] Consumer loop error:", error);
			});
		},
		stop() {
			queue.close();
		},
	};
}
