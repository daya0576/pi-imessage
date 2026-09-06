import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { MessageSender } from "./send.js";

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
			const find = db.prepare(`SELECT m.is_sent AS sent,m.error AS error FROM message m
				JOIN chat_message_join cm ON cm.message_id=m.ROWID JOIN chat c ON c.ROWID=cm.chat_id
				WHERE c.guid=? AND m.is_from_me=1 AND m.text=? ORDER BY m.ROWID DESC LIMIT 1`);
			const sent = () => {
				const row = find.get(chatGuid, text) as { sent: number; error: number } | undefined;
				return row?.sent === 1 && !row.error;
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
