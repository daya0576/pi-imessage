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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, copyFile, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { IncomingMessage, MessageType } from "./types.js";

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

function localDay(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function extensionFor(mimeType: string | null, path: string): string {
	const fromPath = extname(path);
	if (fromPath) return fromPath.toLowerCase();
	switch (mimeType) {
		case "image/jpeg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "image/heic":
			return ".heic";
		case "image/heif":
			return ".heif";
		default:
			return ".img";
	}
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._+-]+/g, "_").slice(0, 80) || "unknown";
}

// ── ChatStore ─────────────────────────────────────────────────────────────────

export interface ChatStoreConfig {
	workingDir: string;
}

export interface ArchivedImageRecord {
	date: string;
	day: string;
	sender: string;
	chatGuid: string;
	originalPath: string;
	archivedPath: string;
	mimeType: string | null;
	sha256: string;
	sizeBytes: number;
	text: string | null;
}

export interface ChatStore {
	log(chatGuid: string, message: Omit<Message, "date">): Promise<void>;
	archiveImages(chatGuid: string, incoming: IncomingMessage): Promise<ArchivedImageRecord[]>;
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

	async function archiveImages(chatGuid: string, incoming: IncomingMessage): Promise<ArchivedImageRecord[]> {
		const now = new Date();
		const date = now.toISOString();
		const day = localDay(now);
		const imageDir = join(chatDir(chatGuid), "images", day);
		mkdirSync(imageDir, { recursive: true });

		const records: ArchivedImageRecord[] = [];
		for (const attachment of incoming.attachments) {
			if (!attachment.mimeType?.startsWith("image/")) continue;

			const originalPath = attachment.path;
			const bytes = await readFile(originalPath);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const extension = extensionFor(attachment.mimeType, originalPath);
			const filename = `${date.replace(/[:.]/g, "-")}-${safeSegment(incoming.sender)}-${sha256.slice(0, 12)}${extension}`;
			const archivedAbsPath = join(imageDir, filename);
			if (!existsSync(archivedAbsPath)) {
				await copyFile(attachment.path, archivedAbsPath);
			}

			const sizeBytes = (await stat(archivedAbsPath)).size;
			const archivedPath = relative(workingDir, archivedAbsPath);
			attachment.path = archivedAbsPath;

			records.push({
				date,
				day,
				sender: incoming.sender,
				chatGuid,
				originalPath,
				archivedPath,
				mimeType: attachment.mimeType,
				sha256,
				sizeBytes,
				text: incoming.text,
			});
		}

		if (records.length > 0) {
			const indexPath = join(chatDir(chatGuid), "images", "index.jsonl");
			await appendFile(indexPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
		}

		return records;
	}

	return {
		async log(chatGuid: string, message: Omit<Message, "date">): Promise<void> {
			await append(chatGuid, { date: new Date().toISOString(), ...message });
		},
		archiveImages,
	};
}
