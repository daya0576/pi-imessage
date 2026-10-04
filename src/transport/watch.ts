import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export type IncomingMessage = {
	rowid: number;
	guid: string;
	chatGuid: string;
	text: string;
	sender: string;
	service: string;
	groupName: string;
	replyTo: string | null;
	attachments: string[];
};
type Row = {
	rowid: number;
	guid: string;
	chatGuid: string | null;
	text: string | null;
	attributedBody: Buffer | null;
	sender: string | null;
	service: string | null;
	groupName: string | null;
	replyGuid: string | null;
	isFromMe: number;
	reaction: number | null;
};
export const defaultDatabasePath = join(homedir(), "Library", "Messages", "chat.db");

export function resolveMessageText(row: { text: string | null; attributedBody: Buffer | null }): string {
	if (row.text?.trim()) return row.text.trim();
	const blob = row.attributedBody;
	if (!blob) return "";
	const marker = blob.indexOf("NSString");
	if (marker < 0) return "";
	let position = blob.indexOf(0x2b, marker + 8) + 1;
	if (position <= 0 || position >= blob.length) return "";
	let length = blob[position++];
	if (length === 0x81) {
		if (position + 2 > blob.length) return "";
		length = blob.readUInt16LE(position);
		position += 2;
	}
	return position + length <= blob.length
		? blob
				.subarray(position, position + length)
				.toString("utf8")
				.trim()
		: "";
}

export function createWatcher(options: {
	dbPath: string;
	cursor?: number;
	intervalMs?: number;
	accept(message: IncomingMessage): Promise<void>;
	saveCursor(rowid: number): Promise<void>;
	onError(error: unknown): void;
}) {
	const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
	let cursor: number;
	try {
		const maximum = (
			db.prepare("SELECT COALESCE(MAX(ROWID),0) AS value FROM message").get() as { value: number }
		).value;
		cursor = options.cursor ?? maximum;
		if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > maximum)
			throw new Error("Messages cursor is invalid or ahead of the database; reconcile it before starting");
	} catch (error) {
		db.close();
		throw error;
	}
	let stopped = false;
	let started = false;
	let closing: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<void> | undefined;
	async function readPage() {
		const rows = db
			.prepare(`SELECT m.ROWID AS rowid,m.guid,m.text,m.attributedBody,
			m.is_from_me AS isFromMe,m.associated_message_type AS reaction,m.service,
			m.thread_originator_guid AS replyGuid,h.id AS sender,c.guid AS chatGuid,c.display_name AS groupName
			FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id
			LEFT JOIN chat_message_join j ON j.message_id=m.ROWID LEFT JOIN chat c ON c.ROWID=j.chat_id
			WHERE m.ROWID>? ORDER BY m.ROWID LIMIT 200`)
			.all(cursor) as Row[];
		for (const row of rows) {
			if (stopped) break;
			if (!row.isFromMe && !row.reaction && row.chatGuid) {
				const attachments = (
					db
						.prepare(`SELECT a.filename FROM attachment a
					JOIN message_attachment_join j ON j.attachment_id=a.ROWID WHERE j.message_id=?`)
						.all(row.rowid) as { filename: string | null }[]
				).flatMap(({ filename }) => (filename ? [filename.replace(/^~(?=\/)/, homedir())] : []));
				const reply = row.replyGuid
					? (db.prepare("SELECT text,attributedBody FROM message WHERE guid=?").get(row.replyGuid) as
							| Row
							| undefined)
					: undefined;
				const text = resolveMessageText(row);
				if (text || attachments.length)
					await options.accept({
						rowid: row.rowid,
						guid: row.guid,
						chatGuid: row.chatGuid,
						text,
						sender: row.sender ?? "unknown",
						service: row.service ?? "iMessage",
						groupName: row.groupName ?? "",
						replyTo: reply ? resolveMessageText(reply) : null,
						attachments,
					});
			}
			await options.saveCursor(row.rowid);
			cursor = row.rowid;
		}
	}
	function poll() {
		if (stopped) return Promise.resolve();
		pending ??= readPage().finally(() => {
			pending = undefined;
		});
		return pending;
	}
	function tick() {
		void poll()
			.catch(options.onError)
			.finally(() => {
				if (!stopped) timer = setTimeout(tick, options.intervalMs ?? 2000);
			});
	}
	return {
		get cursor() {
			return cursor;
		},
		poll,
		start() {
			if (stopped || started) return;
			started = true;
			tick();
		},
		stop() {
			stopped = true;
			clearTimeout(timer);
			closing ??= (async () => {
				await pending?.catch(() => {});
				db.close();
			})();
			return closing;
		},
	};
}
