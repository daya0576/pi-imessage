/**
 * iMessage bot — pulls raw BlueBubbles messages from the monitor queue,
 * assembles them into unified IncomingMessage objects, and runs them
 * through the message pipeline (before → start → end).
 *
 *   monitor.pull() → assembleMessage() → pipeline.process()
 *
 * Pipeline tasks (registered in createIMessageBot):
 *   before : logIncoming, dropSelfEcho
 *   start  : callAgent
 *   end    : sendReply, logOutgoing
 *
 * Message ordering: assembly + pipeline execution is serialised through a
 * promise chain so messages reach the agent in webhook-arrival order.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentManager } from "./agent.js";
import { QueueClosedError, createBBMonitor, createSelfEchoFilter } from "./bluebubble/index.js";
import type { BBAttachment, BBClient, BBRawMessage } from "./bluebubble/index.js";
import { createMessagePipeline } from "./pipeline.js";
import {
	createCallAgentTask,
	createDropSelfEchoTask,
	createLogIncomingTask,
	createLogOutgoingTask,
	createSendReplyTask,
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
 * Download image attachments into memory and return as ImageContent[].
 * Non-image attachments are skipped with a warning. Failed image downloads
 * are logged and silently skipped.
 */
async function downloadImages(attachments: BBAttachment[], bbClient: BBClient): Promise<ImageContent[]> {
	const images: ImageContent[] = [];
	for (const attachment of attachments) {
		const mimeType = attachment.mimeType;
		if (!mimeType?.startsWith("image/")) {
			console.warn(`[blue] skipping non-image attachment ${attachment.guid} (mimeType: ${mimeType ?? "null"})`);
			continue;
		}
		try {
			const bytes = await bbClient.downloadAttachmentBytes(attachment.guid);
			images.push({ type: "image", mimeType, data: bytes.toString("base64") });
		} catch (error) {
			console.error(`[blue] failed to download image attachment ${attachment.guid}:`, error);
		}
	}
	return images;
}

/**
 * Assemble a raw BlueBubbles message into a unified IncomingMessage.
 * Downloads image attachments and derives messageType / sender / groupName.
 */
export async function assembleMessage(raw: BBRawMessage, bbClient: BBClient): Promise<IncomingMessage> {
	const chatGuid = raw.chats[0].guid;
	const messageType = deriveMessageType(raw, chatGuid);
	const text = raw.text?.trim() ?? null;
	const sender = raw.handle?.address ?? "unknown";
	const groupName = raw.chats[0].displayName ?? "";
	const attachments = raw.attachments ?? [];
	const images = attachments.length > 0 ? await downloadImages(attachments, bbClient) : [];
	return { chatGuid, text, sender, messageType, groupName, images };
}

// ── iMessage bot ──────────────────────────────────────────────────────────────

export interface IMessageBotConfig {
	port: number;
	agent: AgentManager;
	blueBubblesClient: BBClient;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { port, agent, blueBubblesClient } = config;
	const echoFilter = createSelfEchoFilter();
	const monitor = createBBMonitor({ port });
	const pipeline = createMessagePipeline();

	// ── Pipeline tasks ─────────────────────────────────────────────────────────

	// before
	pipeline.before(createLogIncomingTask());
	pipeline.before(createDropSelfEchoTask(echoFilter));

	// start
	pipeline.start(createCallAgentTask(agent));

	// end
	pipeline.end(createSendReplyTask(echoFilter, blueBubblesClient));
	pipeline.end(createLogOutgoingTask());

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
				const raw = await monitor.pull();
				processChain = processChain
					.then(async () => {
						const msg = await assembleMessage(raw, blueBubblesClient);
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
			monitor.start();
			consumeLoop().catch((error) => {
				console.error("[blue] Consumer loop error:", error);
			});
		},
		stop() {
			monitor.stop();
		},
	};
}
