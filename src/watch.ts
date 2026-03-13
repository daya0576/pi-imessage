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
		message.is_from_me       AS is_from_me,
		message.service          AS service,
		message.associated_message_type AS reaction_type,
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
	is_from_me: number;
	service: string | null;
	reaction_type: number | null;
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

	function poll(): void {
		try {
			const rows = db.prepare(MESSAGES_QUERY).all(lastTimestamp) as RawRow[];

			for (const row of rows) {
				if (seenRowIds.has(row.rowid)) continue;
				if (!row.chat_guid) continue;

				const hasText = Boolean(row.text?.trim());
				const attachments = getAttachments(row.rowid);
				if (!hasText && attachments.length === 0) continue;

				seenRowIds.add(row.rowid);

				const msg: IncomingMessage = {
					chatGuid: row.chat_guid,
					text: row.text?.trim() ?? null,
					sender: row.sender ?? "unknown",
					messageType: deriveMessageType(row.service, row.is_group),
					groupName: row.group_name ?? "",
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
