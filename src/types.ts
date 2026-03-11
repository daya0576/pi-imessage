/**
 * Shared types for the iMessage bot pipeline.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import type { BBAttachment } from "./bluebubble/index.js";

/**
 * Message type, derived from the BlueBubbles handle service and chatGuid:
 *
 *   handle.service    chatGuid segment    MessageType
 *   ──────────────    ───────────────     ───────────
 *   "SMS"             (any)               "sms"
 *   "iMessage"        ";-;" (DM)          "imessage"
 *   "iMessage"        ";+;" (group)       "group"
 */
export type MessageType = "sms" | "imessage" | "group";

/**
 * Unified incoming message flowing through the entire pipeline.
 *
 * Fully assembled by the iMessage layer — `images` are already downloaded
 * and base64-encoded by the time the message reaches the agent.
 */
export interface IncomingMessage {
	chatGuid: string;
	text: string | null;
	sender: string;
	messageType: MessageType;
	groupName: string;
	/** Raw attachments from BlueBubbles — populated during assembly. */
	attachments: BBAttachment[];
	/** Image attachments, downloaded and base64-encoded by the downloadImages pipeline task. */
	images: ImageContent[];
}

// ── Outgoing message (pipeline response model) ───────────────────────────────

/** What kind of reply the bot should send back. */
export type ReplyAction =
	| { type: "message"; text: string }
	| { type: "reaction"; messageGuid: string; reaction: string }
	| { type: "none" };

/**
 * Structured pipeline response, carried as context through all phases.
 *
 *   reply          — the reply action to perform (text, reaction, or nothing).
 *   shouldContinue — if false, remaining tasks in the current phase and all
 *                    later phases are skipped.
 *   sendReply      — if false, the reply is logged but not sent to the user
 *                    (e.g. agent encountered an error).
 */
export interface OutgoingMessage {
	reply: ReplyAction;
	shouldContinue: boolean;
	sendReply: boolean;
}

/** Create a default OutgoingMessage (no reply, continue processing). */
export function createOutgoingMessage(): OutgoingMessage {
	return { reply: { type: "none" }, shouldContinue: true, sendReply: true };
}
