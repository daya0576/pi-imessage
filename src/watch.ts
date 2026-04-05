/**
 * Watch for new iMessages by polling ~/Library/Messages/chat.db.
 *
 *   ┌──────────┐  poll   ┌──────────┐  push   ┌───────┐
 *   │ chat.db  │ ──────> │ watch.ts │ ──────> │ queue │
 *   └──────────┘         └──────────┘         └───────┘
 *
 * Replaces BlueBubbles webhook monitor — no server, no external dependency.
 * Requires Full Disk Access for the terminal / Node process.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { AsyncQueue } from "./queue.js";
import type { Attachment, IncomingMessage, MessageType } from "./types.js";

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** macOS Core Data epoch: 2001-01-01T00:00:00Z in milliseconds. */
const MAC_EPOCH_MS = new Date("2001-01-01T00:00:00Z").getTime();

// ── SQL ───────────────────────────────────────────────────────────────────────

const MESSAGES_QUERY = `
	SELECT
		message.ROWID            AS rowid,
		message.text             AS text,
		message.attributedBody   AS attributedBody,
		message.is_from_me       AS is_from_me,
		message.service          AS service,
		message.associated_message_type AS reaction_type,
		message.thread_originator_guid AS thread_originator_guid,
		handle.id                AS sender,
		chat.guid                AS chat_guid,
		chat.display_name        AS group_name,
		(SELECT COUNT(*) FROM chat_handle_join WHERE chat_handle_join.chat_id = chat.ROWID) > 1 AS is_group
	FROM message
	LEFT JOIN handle ON message.handle_id = handle.ROWID
	LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
	LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID
	WHERE message.date > ?
	  AND message.is_from_me = 0
	  AND (message.associated_message_type IS NULL OR message.associated_message_type = 0)
	ORDER BY message.date ASC
`;

const REPLY_TO_QUERY = `
	SELECT message.text AS text
	FROM message
	WHERE message.guid = ?
	LIMIT 1
`;

const ATTACHMENTS_QUERY = `
	SELECT
		attachment.filename   AS filename,
		attachment.mime_type  AS mime_type
	FROM attachment
	INNER JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
	WHERE message_attachment_join.message_id = ?
`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawRow {
	rowid: number;
	text: string | null;
	attributedBody: Buffer | null;
	is_from_me: number;
	service: string | null;
	reaction_type: number | null;
	thread_originator_guid: string | null;
	sender: string | null;
	chat_guid: string | null;
	group_name: string | null;
	is_group: number;
}

interface AttachmentRow {
	filename: string | null;
	mime_type: string | null;
}

// ── Watcher ───────────────────────────────────────────────────────────────────

export interface WatcherConfig {
	queue: AsyncQueue<IncomingMessage>;
	pollIntervalMs?: number;
}

export function createWatcher(config: WatcherConfig) {
	const { queue, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = config;
	const dbPath = join(homedir(), "Library", "Messages", "chat.db");

	let db: Database.Database;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let lastTimestamp = (Date.now() - MAC_EPOCH_MS) * 1_000_000; // now, in macOS nanoseconds
	const seenRowIds = new Set<number>();

	function deriveMessageType(service: string | null, isGroup: number): MessageType {
		if (service?.toLowerCase().includes("sms")) return "sms";
		return isGroup ? "group" : "imessage";
	}

	/**
	 * Extract plain text from an attributedBody blob (NSKeyedArchiver typedstream).
	 *
	 * Binary layout after "NSString" class declaration:
	 *   \x01\x94\x84\x01\x2b  — fixed header ('+' type marker)
	 *   length                 — 1 byte if < 0x81, otherwise \x81 + 2-byte big-endian
	 *   UTF-8 text bytes
	 *   \x86                   — terminator
	 *
	 * Returns null if extraction fails — caller should treat as no text.
	 */
	function extractTextFromAttributedBody(blob: Buffer): string | null {
		try {
			const marker = Buffer.from("NSString");
			const markerIdx = blob.indexOf(marker);
			if (markerIdx === -1) return null;

			// Skip marker + fixed header bytes, find the '+' (0x2b) type indicator
			let pos = markerIdx + marker.length;
			while (pos < blob.length && blob[pos] !== 0x2b) pos++;
			if (pos >= blob.length) return null;
			pos++; // skip 0x2b

			// Read length
			let textLength: number;
			if (blob[pos] === 0x81) {
				// 2-byte little-endian length follows
				pos++;
				if (pos + 2 > blob.length) return null;
				textLength = blob[pos] | (blob[pos + 1] << 8);
				pos += 2;
			} else {
				textLength = blob[pos];
				pos++;
			}

			if (textLength <= 0 || pos + textLength > blob.length) return null;

			const text = blob
				.subarray(pos, pos + textLength)
				.toString("utf-8")
				.trim();
			return text || null;
		} catch {
			return null;
		}
	}

	/** Resolve message text: prefer message.text, fall back to attributedBody. */
	function resolveText(row: RawRow): string | null {
		const text = row.text?.trim();
		if (text) return text;
		if (row.attributedBody) return extractTextFromAttributedBody(row.attributedBody);
		return null;
	}

	function expandPath(rawPath: string): string {
		if (rawPath.startsWith("~")) return rawPath.replace(/^~/, homedir());
		return rawPath;
	}

	function getAttachments(rowid: number): Attachment[] {
		const rows = db.prepare(ATTACHMENTS_QUERY).all(rowid) as AttachmentRow[];
		return rows
			.filter((r) => r.filename)
			.map((r) => ({
				path: expandPath(r.filename ?? ""),
				mimeType: r.mime_type ?? null,
			}));
	}

	/** Look up the text of a replied-to message by its guid. Returns null on miss. */
	function getReplyToText(guid: string): string | null {
		try {
			const row = db.prepare(REPLY_TO_QUERY).get(guid) as { text: string | null } | undefined;
			return row?.text?.trim() || null;
		} catch {
			return null;
		}
	}

	function poll(): void {
		try {
			const rows = db.prepare(MESSAGES_QUERY).all(lastTimestamp) as RawRow[];

			for (const row of rows) {
				if (seenRowIds.has(row.rowid)) continue;
				if (!row.chat_guid) continue;

				const resolvedText = resolveText(row);
				const hasText = Boolean(resolvedText);
				const attachments = getAttachments(row.rowid);
				if (!hasText && attachments.length === 0) continue;

				seenRowIds.add(row.rowid);

				const replyToText = row.thread_originator_guid ? getReplyToText(row.thread_originator_guid) : null;

				const msg: IncomingMessage = {
					chatGuid: row.chat_guid,
					text: resolvedText,
					sender: row.sender ?? "unknown",
					messageType: deriveMessageType(row.service, row.is_group),
					groupName: row.group_name ?? "",
					replyToText,
					attachments,
					images: [],
				};

				queue.push(msg);
			}

			// Advance timestamp to latest seen row
			if (rows.length > 0) {
				// Re-query max date to advance cursor
				const maxDate = db
					.prepare(`SELECT MAX(date) AS max_date FROM message WHERE ROWID IN (${rows.map(() => "?").join(",")})`)
					.get(...rows.map((r) => r.rowid)) as { max_date: number } | undefined;
				if (maxDate?.max_date) {
					lastTimestamp = maxDate.max_date;
				}
			}

			// Prune seenRowIds — keep last 10000
			if (seenRowIds.size > 10_000) {
				const entries = [...seenRowIds];
				for (let i = 0; i < entries.length - 5_000; i++) {
					seenRowIds.delete(entries[i]);
				}
			}
		} catch (error) {
			console.error("[watch] poll error:", error);
		}
	}

	return {
		start(): void {
			db = new Database(dbPath, { readonly: true });
			console.log(`[watch] polling chat.db every ${pollIntervalMs}ms`);
			poll(); // initial poll to set cursor (catches nothing on first run)
			intervalId = setInterval(poll, pollIntervalMs);
		},

		stop(): void {
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null;
			}
			db?.close();
			queue.close();
			console.log("[watch] stopped");
		},
	};
}
