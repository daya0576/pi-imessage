/**
 * Pipeline task factories — each function creates a task for a specific
 * pipeline phase. Tasks are pure functions with injected dependencies;
 * the bot registers them without containing any business logic itself.
 *
 * before:
 *   logIncoming      — logs the received message
 *   dropSelfEcho     — drops messages that are echoes of the bot's own replies
 *
 * start:
 *   callAgent        — sends the message to the agent and sets the reply
 *
 * end:
 *   sendReply        — remembers echo, sends reply via BlueBubbles
 *   logOutgoing      — logs the outgoing reply
 */

import type { AgentManager } from "./agent.js";
import type { BBClient } from "./bluebubble/index.js";
import type { SelfEchoFilter } from "./bluebubble/index.js";
import type { BeforeTask, EndTask, StartTask } from "./pipeline.js";
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

/** Log the incoming message with type-appropriate formatting. Always passes through. */
export function createLogIncomingTask(): BeforeTask {
	return (incoming, outgoing) => {
		const label = messageTypeLabel(incoming);
		const target = formatTarget(incoming);
		const attachmentNote = incoming.images.length > 0 ? ` [${incoming.images.length} image(s)]` : "";
		console.log(`[blue] <- [${label}] ${target}: ${(incoming.text ?? "(image)").substring(0, 80)}${attachmentNote}`);
		return outgoing;
	};
}

/** Drop messages that are echoes of the bot's own replies. */
export function createDropSelfEchoTask(echoFilter: SelfEchoFilter): BeforeTask {
	return (incoming, outgoing) => {
		if (incoming.text && echoFilter.isEcho(incoming.chatGuid, incoming.text)) {
			console.warn(`[blue] drop self-echo ${incoming.chatGuid}: ${incoming.text.substring(0, 40)}`);
			return { ...outgoing, shouldContinue: false };
		}
		return outgoing;
	};
}

// ── start tasks ───────────────────────────────────────────────────────────────

/** Send the message to the agent and set the reply action on the outgoing context. */
export function createCallAgentTask(agent: AgentManager): StartTask {
	return async (incoming, outgoing) => {
		const replyText = await agent.processMessage(incoming);
		if (replyText) {
			return { ...outgoing, reply: { type: "message" as const, text: replyText } };
		}
		return outgoing;
	};
}

// ── end tasks ─────────────────────────────────────────────────────────────────

/** Remember echo and send reply via BlueBubbles based on the reply action. */
export function createSendReplyTask(echoFilter: SelfEchoFilter, blueBubblesClient: BBClient): EndTask {
	return async (incoming, outgoing) => {
		const { reply } = outgoing;
		if (reply.type === "message") {
			echoFilter.remember(incoming.chatGuid, reply.text);
			await blueBubblesClient.sendMessage(incoming.chatGuid, reply.text);
		} else if (reply.type === "reaction") {
			await blueBubblesClient.sendReaction(incoming.chatGuid, reply.messageGuid, reply.reaction);
		}
		return outgoing;
	};
}

/** Log the outgoing reply. */
export function createLogOutgoingTask(): EndTask {
	return (incoming, outgoing) => {
		const { reply } = outgoing;
		if (reply.type === "message") {
			const label = messageTypeLabel(incoming);
			const target = incoming.messageType === "group" ? incoming.groupName : incoming.sender;
			console.log(`[blue] -> [${label}] ${target}: ${reply.text.substring(0, 80)}`);
		} else if (reply.type === "reaction") {
			const label = messageTypeLabel(incoming);
			const target = incoming.messageType === "group" ? incoming.groupName : incoming.sender;
			console.log(`[blue] -> [${label}] ${target}: (reaction: ${reply.reaction})`);
		}
		return outgoing;
	};
}
