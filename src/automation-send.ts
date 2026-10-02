import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { MessageSender } from "./send.js";

export function notificationText(blob: Buffer | null): string | null {
	if (!blob) return null;
	const marker = blob.indexOf(Buffer.from("NSString"));
	if (marker < 0) return null;
	let offset = blob.indexOf(0x2b, marker + 8) + 1;
	if (offset <= 0 || offset >= blob.length) return null;
	let length = blob[offset++];
	if (length === 0x81) {
		if (offset + 2 > blob.length) return null;
		length = blob.readUInt16LE(offset);
		offset += 2;
	} else if (length === 0x82) {
		if (offset + 4 > blob.length) return null;
		length = blob.readUInt32LE(offset);
		offset += 4;
	}
	if (length <= 0 || offset + length > blob.length) return null;
	return blob
		.subarray(offset, offset + length)
		.toString("utf8")
		.trim();
}

/** Verify local Messages send state; this is not recipient delivery/read confirmation. */
export function createAutomationNotifier(
	sender: Pick<MessageSender, "sendMessage">,
	remember: (chatGuid: string, text: string) => void,
	options: { dbPath?: string; waitMs?: number } = {}
): (chatGuid: string, text: string) => Promise<void> {
	return async (chatGuid, text) => {
		// Notifications include a stable outbox reference. A retry checks for late success
		// before resending, rather than trusting an AppleScript/HTTP acknowledgement.
		const db = new Database(options.dbPath ?? join(homedir(), "Library/Messages/chat.db"), {
			readonly: true,
			fileMustExist: true,
		});
		try {
			const find = db.prepare(`SELECT m.is_sent AS sent,m.error AS error,m.text,m.attributedBody FROM message m
				JOIN chat_message_join cm ON cm.message_id=m.ROWID JOIN chat c ON c.ROWID=cm.chat_id
				WHERE c.guid=? AND m.is_from_me=1 AND (m.text=? OR (m.text IS NULL AND instr(m.attributedBody,CAST(? AS BLOB))>0)) ORDER BY m.ROWID DESC LIMIT 10`);
			const sent = () => {
				const rows = find.all(chatGuid, text, text) as {
					sent: number;
					error: number;
					text: string | null;
					attributedBody: Buffer | null;
				}[];
				return rows.some(
					(row) => row.sent === 1 && !row.error && (row.text ?? notificationText(row.attributedBody)) === text
				);
			};
			if (sent()) return;
			remember(chatGuid, text);
			try {
				await sender.sendMessage(chatGuid, text);
			} catch {
				// An uncertain send can still appear in Messages later; inspect below.
			}
			const deadline = Date.now() + (options.waitMs ?? 10_000);
			do {
				if (sent()) return;
				await new Promise((resolve) => setTimeout(resolve, 100));
			} while (Date.now() < deadline);
			throw new Error("Automation notification send not verified");
		} finally {
			db.close();
		}
	};
}
