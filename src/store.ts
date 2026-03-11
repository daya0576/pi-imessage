/**
 * ChatStore — persistent message log for each iMessage chat.
 *
 * Workspace layout:
 *
 *   workingDir/
 *     <chatGuid>/          e.g. "iMessage;-;+16501234567"
 *       log.jsonl          one JSON line per message, append-only
 *
 * Each line is a LoggedMessage serialised as JSON.
 * The file is never rewritten — only appended to.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, MessageType } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoggedMessage {
	/** ISO 8601 timestamp. */
	date: string;
	/** Sender handle (phone / email) or "bot". */
	sender: string;
	text: string | null;
	/** Local paths of attachments, relative to workingDir. */
	attachments: string[];
	isBot: boolean;
	messageType: MessageType;
	/** Group name, only present when messageType is "group". */
	groupName?: string;
	/** Set when the bot encountered an error and did not send a reply. */
	isError?: boolean;
}

// ── Display helpers ───────────────────────────────────────────────────────────

/** Sender label for display: "bot" for bot messages, otherwise the raw sender handle. */
export function senderLabel(message: LoggedMessage): string {
	return message.isBot ? "bot" : message.sender;
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
	logIncoming(message: IncomingMessage): Promise<void>;
	logOutgoing(
		chatGuid: string,
		text: string,
		messageType: MessageType,
		groupName?: string,
		isError?: boolean
	): Promise<void>;
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

	async function append(chatGuid: string, entry: LoggedMessage): Promise<void> {
		await appendFile(logPath(chatGuid), `${JSON.stringify(entry)}\n`, "utf-8");
	}

	return {
		async logIncoming(message: IncomingMessage): Promise<void> {
			const attachmentPaths = message.attachments.map((a) => join(message.chatGuid, "attachments", a.guid));
			await append(message.chatGuid, {
				date: new Date().toISOString(),
				sender: message.sender,
				text: message.text,
				attachments: attachmentPaths,
				isBot: false,
				messageType: message.messageType,
				...(message.messageType === "group" && { groupName: message.groupName }),
			});
		},

		async logOutgoing(
			chatGuid: string,
			text: string,
			messageType: MessageType,
			groupName?: string,
			isError?: boolean
		): Promise<void> {
			await append(chatGuid, {
				date: new Date().toISOString(),
				sender: "bot",
				text,
				attachments: [],
				isBot: true,
				isError: isError === true ? true : undefined,
				messageType,
				...(messageType === "group" && { groupName }),
			});
		},
	};
}
