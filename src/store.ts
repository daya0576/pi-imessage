/**
 * ChatStore — persistent message log for each iMessage chat.
 *
 * Workspace layout:
 *
 *   workingDir/
 *     <chatGuid>/          e.g. "iMessage;-;+16501234567"
 *       log.jsonl          one JSON line per message, append-only
 *
 * Each line is a Message serialised as JSON.
 * The file is never rewritten — only appended to.
 */

import { existsSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageType } from "./types.js";

// ── Message ───────────────────────────────────────────────────────────────────

/**
 * A message in a chat — user or bot.
 *
 * Both incoming (fromAgent=false) and outgoing (fromAgent=true) messages share
 * the same shape; the only structural difference is the sender.
 */
export interface Message {
	/** ISO 8601 timestamp. */
	date: string;
	/** Sender handle (phone / email), or "bot" for agent replies. */
	sender: string;
	text: string | null;
	/** Local paths of attachments, relative to workingDir. */
	attachments: string[];
	fromAgent: boolean;
	messageType: MessageType;
	/** Group name, only present when messageType is "group". */
	groupName?: string;
}

// ── Display helpers ───────────────────────────────────────────────────────────

/** Sender label for display: "bot" for agent messages, otherwise the raw sender handle. */
export function senderLabel(message: Message): string {
	return message.fromAgent ? "bot" : message.sender;
}

/** Collapse multiline text to its first line with "..." appended. */
export function firstLinePreview(text: string | null): string {
	const full = text && text.trim() !== "" ? text : "[image]";
	const firstLine = full.split("\n")[0] ?? "";
	return full.includes("\n") ? `${firstLine}...` : full;
}

// ── ChatStore ─────────────────────────────────────────────────────────────────

export interface ChatStoreConfig {
	workingDir: string;
}

export interface ChatStore {
	log(chatGuid: string, message: Omit<Message, "date">): Promise<void>;
}

export function createChatStore(config: ChatStoreConfig): ChatStore {
	const { workingDir } = config;

	if (!existsSync(workingDir)) {
		mkdirSync(workingDir, { recursive: true });
	}

	function chatDir(chatGuid: string): string {
		const dir = join(workingDir, chatGuid);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	function logPath(chatGuid: string): string {
		return join(chatDir(chatGuid), "log.jsonl");
	}

	async function append(chatGuid: string, message: Message): Promise<void> {
		await appendFile(logPath(chatGuid), `${JSON.stringify(message)}\n`, "utf-8");
	}

	return {
		async log(chatGuid: string, message: Omit<Message, "date">): Promise<void> {
			await append(chatGuid, { date: new Date().toISOString(), ...message });
		},
	};
}
