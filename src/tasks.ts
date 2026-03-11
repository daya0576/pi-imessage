/**
 * Pipeline task factories — each function creates a task for a specific
 * pipeline phase. Tasks are pure functions with injected dependencies;
 * the bot registers them without containing any business logic itself.
 *
 * before:
 *   logIncoming      — logs the received message
 *   dropSelfEcho     — drops messages that are echoes of the bot's own replies
 *   checkReplyEnabled — drops messages when reply is disabled by settings
 *
 * start:
 *   commandHandler   — intercepts slash commands (/new, /status) before the agent
 *   downloadImages   — downloads image attachments and populates incoming.images
 *   callAgent        — sends the message to the agent and yields replies as they arrive
 *
 * end:
 *   sendReply        — remembers echo, sends reply via BlueBubbles
 *   logOutgoing      — logs the outgoing reply
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentManager } from "./agent.js";
import type { BBClient } from "./bluebubble/index.js";
import type { SelfEchoFilter } from "./bluebubble/index.js";
import type { DigestLogger } from "./logger.js";
import type { BeforeTask, DispatchFn, EndTask, StartTask } from "./pipeline.js";
import type { Settings } from "./settings.js";
import { isReplyEnabled } from "./settings.js";
import type { ChatStore } from "./store.js";
import type { IncomingMessage, OutgoingMessage } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function messageTypeLabel(msg: IncomingMessage): string {
	if (msg.messageType === "group") return "GROUP";
	return msg.messageType === "sms" ? "SMS" : "DM";
}

function formatTarget(msg: IncomingMessage): string {
	return msg.messageType === "group" ? `${msg.groupName}|${msg.sender}` : msg.sender;
}

// ── before tasks ──────────────────────────────────────────────────────────────

/**
 * Log the incoming message to console. Always passes through.
 *
 * Examples:
 *   [sid] <- [DM]    +16501234567: hey what's up
 *   [sid] <- [SMS]   +16501234567: can you call me
 *   [sid] <- [GROUP] Family|+16501234567: dinner at 6? [2 attachment(s)]
 */
export function createLogIncomingTask(digestLogger: DigestLogger): BeforeTask {
	return (incoming, outgoing) => {
		const label = messageTypeLabel(incoming);
		const target = formatTarget(incoming);
		const attachmentNote = incoming.attachments.length > 0 ? ` [${incoming.attachments.length} attachment(s)]` : "";
		digestLogger.log(
			`[sid] <- [${label}] ${target}: ${(incoming.text ?? "(attachment)").substring(0, 80)}${attachmentNote}`
		);
		return outgoing;
	};
}

/** Persist the incoming message to log.jsonl. Always passes through. */
export function createStoreIncomingTask(store: ChatStore): BeforeTask {
	return (incoming, outgoing) => {
		store.logIncoming(incoming).catch((error) => {
			console.error(`[sid] failed to store incoming message for ${incoming.chatGuid}:`, error);
		});
		return outgoing;
	};
}

/** Drop messages that are echoes of the bot's own replies. */
export function createDropSelfEchoTask(echoFilter: SelfEchoFilter): BeforeTask {
	return (incoming, outgoing) => {
		if (incoming.text && echoFilter.isEcho(incoming.chatGuid, incoming.text)) {
			console.warn(`[sid] drop self-echo ${incoming.chatGuid}: ${incoming.text.substring(0, 40)}`);
			return { ...outgoing, shouldContinue: false };
		}
		return outgoing;
	};
}

/**
 * Drop messages when reply is disabled for this chat by settings.
 *
 * Resolution priority (highest to lowest):
 *   blacklist["chatGuid"] > whitelist["chatGuid"] > blacklist["*"] > whitelist["*"]
 *
 * Examples:
 *   whitelist: ["*"]              → reply to everyone
 *   whitelist: ["1"]              → reply only to "1"
 *   whitelist: ["*"], bl: ["2"]   → reply to everyone except "2"
 *   blacklist: ["*"]              → log-only for all
 *   whitelist: ["1"], bl: ["*"]   → reply only to "1"
 *   whitelist: ["1"], bl: ["1"]   → no reply (blacklist wins)
 */
export function createCheckReplyEnabledTask(getSettings: () => Settings): BeforeTask {
	return (incoming, outgoing) => {
		if (!isReplyEnabled(getSettings(), incoming.chatGuid)) {
			console.log(`[sid] reply disabled for ${incoming.chatGuid}, log-only`);
			return { ...outgoing, shouldContinue: false };
		}
		return outgoing;
	};
}

// ── command tasks ─────────────────────────────────────────────────────────────

/**
 * Intercept slash commands (e.g. "/new", "/status") before they reach the agent.
 * Sets shouldContinue=false on the outgoing message to skip subsequent start tasks.
 *
 * Supported commands:
 *   /new    — reset the agent session for this chat (equivalent to /new in pi coding agent).
 *   /status — show session stats: tokens, cost, context usage, model, thinking level.
 */
export function createCommandHandlerTask(agent: AgentManager): StartTask {
	return async (incoming, outgoing, dispatch) => {
		const text = incoming.text?.trim();

		if (text === "/new") {
			await agent.resetSession(incoming.chatGuid);
			const resetReply = "✓ New session started";
			console.log(`[sid] /new command: ${incoming.chatGuid} → ${resetReply}`);
			await dispatch({ ...outgoing, reply: { type: "message", text: resetReply } });

			const statusReply = await agent.getSessionStatus(incoming.chatGuid);
			console.log(`[sid] /new status: ${incoming.chatGuid} → ${statusReply}`);
			await dispatch({ ...outgoing, reply: { type: "message", text: statusReply } });

			outgoing.shouldContinue = false;
			return;
		}

		if (text === "/status") {
			const replyText = await agent.getSessionStatus(incoming.chatGuid);
			console.log(`[sid] /status command: ${incoming.chatGuid} → ${replyText}`);
			await dispatch({ ...outgoing, reply: { type: "message", text: replyText } });
			outgoing.shouldContinue = false;
			return;
		}
	};
}

// ── start tasks ───────────────────────────────────────────────────────────────

/**
 * Download image attachments from incoming.attachments and populate
 * incoming.images in-place. Non-image attachments are skipped with a warning;
 * failed downloads are logged and silently skipped.
 */
export function createDownloadImagesTask(bbClient: BBClient): BeforeTask {
	return async (incoming, outgoing) => {
		const images: ImageContent[] = [];
		for (const attachment of incoming.attachments) {
			const mimeType = attachment.mimeType;
			if (!mimeType?.startsWith("image/")) {
				console.warn(`[sid] skipping non-image attachment ${attachment.guid} (mimeType: ${mimeType ?? "null"})`);
				continue;
			}
			try {
				const bytes = await bbClient.downloadAttachmentBytes(attachment.guid);
				images.push({ type: "image", mimeType, data: bytes.toString("base64") });
			} catch (error) {
				console.error(`[sid] failed to download image attachment ${attachment.guid}:`, error);
			}
		}
		incoming.images = images;
		return outgoing;
	};
}

/** Send the message to the agent and dispatch a reply for each agent turn. */
export function createCallAgentTask(agent: AgentManager): StartTask {
	return async (incoming, outgoing, dispatch) => {
		await agent.processMessage(incoming, async (reply) => {
			await dispatch({ ...outgoing, reply: { type: "message" as const, text: reply } });
		});
	};
}

// ── end tasks ─────────────────────────────────────────────────────────────────

/** Remember echo and send reply via BlueBubbles based on the reply action. */
export function createSendReplyTask(echoFilter: SelfEchoFilter, blueBubblesClient: BBClient): EndTask {
	return async (incoming, outgoing) => {
		const { reply, sendReply } = outgoing;
		if (!sendReply) return outgoing;
		if (reply.type === "message") {
			echoFilter.remember(incoming.chatGuid, reply.text);
			await blueBubblesClient.sendMessage(incoming.chatGuid, reply.text);
		} else if (reply.type === "reaction") {
			await blueBubblesClient.sendReaction(incoming.chatGuid, reply.messageGuid, reply.reaction);
		}
		return outgoing;
	};
}

/**
 * Log the outgoing reply to console.
 *
 * Examples:
 *   [sid] -> [DM]    +16501234567: sure, I'll check
 *   [sid] -> [SMS]   +16501234567: got it
 *   [sid] -> [GROUP] Family: sounds good!
 *   [sid] -> [DM]    +16501234567: (reaction: love)
 */
export function createLogOutgoingTask(digestLogger: DigestLogger): EndTask {
	return (incoming, outgoing) => {
		const { reply } = outgoing;
		if (reply.type === "message") {
			const label = messageTypeLabel(incoming);
			const target = incoming.messageType === "group" ? incoming.groupName : incoming.sender;
			digestLogger.log(`[sid] -> [${label}] ${target}: ${reply.text.substring(0, 80)}`);
		} else if (reply.type === "reaction") {
			const label = messageTypeLabel(incoming);
			const target = incoming.messageType === "group" ? incoming.groupName : incoming.sender;
			digestLogger.log(`[sid] -> [${label}] ${target}: (reaction: ${reply.reaction})`);
		}
		return outgoing;
	};
}

/** Persist the outgoing reply to log.jsonl. */
export function createStoreOutgoingTask(store: ChatStore): EndTask {
	return (incoming, outgoing) => {
		const { reply, sendReply } = outgoing;
		if (reply.type === "message") {
			store
				.logOutgoing(incoming.chatGuid, reply.text, incoming.messageType, incoming.groupName, !sendReply)
				.catch((error) => {
					console.error(`[sid] failed to store outgoing message for ${incoming.chatGuid}:`, error);
				});
		}
		return outgoing;
	};
}
