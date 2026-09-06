import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createAutomationNotifier, notificationText } from "../automation-send.js";

it("verifies Messages state and deduplicates late-success retries", async () => {
	const root = mkdtempSync(join(tmpdir(), "automation-send-"));
	const dbPath = join(root, "messages.db");
	const db = new Database(dbPath);
	db.exec(
		"CREATE TABLE message (is_sent INTEGER,error INTEGER,is_from_me INTEGER,text TEXT,attributedBody BLOB); CREATE TABLE chat (guid TEXT); CREATE TABLE chat_message_join(message_id INTEGER,chat_id INTEGER); INSERT INTO chat VALUES ('fixture');"
	);
	const sender = {
		sendMessage: vi.fn(async (_chat: string, text: string) => {
			const id = db
				.prepare("INSERT INTO message(is_sent,error,is_from_me,text) VALUES (1,0,1,?)")
				.run(text).lastInsertRowid;
			db.prepare("INSERT INTO chat_message_join VALUES (?,1)").run(id);
		}),
	};
	try {
		const notify = createAutomationNotifier(sender, vi.fn(), { dbPath, waitMs: 100 });
		await notify("fixture", "incident 1");
		await notify("fixture", "incident 1");
		expect(sender.sendMessage).toHaveBeenCalledTimes(1);
		const raw = Buffer.from("中文通知 〔任务通知 3〕");
		const blob = Buffer.concat([
			Buffer.from("NSString"),
			Buffer.from([1, 0x94, 0x84, 1, 0x2b, raw.length]),
			raw,
			Buffer.from([0x86]),
		]);
		expect(notificationText(blob)).toBe(raw.toString());
		const rowId = db.prepare("INSERT INTO message VALUES (1,0,1,NULL,?)").run(blob).lastInsertRowid;
		db.prepare("INSERT INTO chat_message_join VALUES (?,1)").run(rowId);
		await notify("fixture", raw.toString());
		expect(sender.sendMessage).toHaveBeenCalledTimes(1);
		const silent = { sendMessage: vi.fn(async () => {}) };
		await expect(
			createAutomationNotifier(silent, vi.fn(), { dbPath, waitMs: 100 })("fixture", "incident 2")
		).rejects.toThrow("not verified");
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
