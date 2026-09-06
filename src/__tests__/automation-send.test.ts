import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createAutomationNotifier } from "../automation-send.js";

it("verifies Messages state and deduplicates late-success retries", async () => {
	const root = mkdtempSync(join(tmpdir(), "automation-send-"));
	const dbPath = join(root, "messages.db");
	const db = new Database(dbPath);
	db.exec(
		"CREATE TABLE message (is_sent INTEGER,error INTEGER,is_from_me INTEGER,text TEXT); CREATE TABLE chat (guid TEXT); CREATE TABLE chat_message_join(message_id INTEGER,chat_id INTEGER); INSERT INTO chat VALUES ('fixture');"
	);
	const sender = {
		sendMessage: vi.fn(async (_chat: string, text: string) => {
			const id = db.prepare("INSERT INTO message VALUES (1,0,1,?)").run(text).lastInsertRowid;
			db.prepare("INSERT INTO chat_message_join VALUES (?,1)").run(id);
		}),
	};
	try {
		const notify = createAutomationNotifier(sender, vi.fn(), { dbPath, waitMs: 100 });
		await notify("fixture", "incident 1");
		await notify("fixture", "incident 1");
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
