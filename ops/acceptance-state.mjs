// Read-only production inventory and isolated compatibility rehearsal; never start workers.
// Run with tsx: npx tsx ops/acceptance-state.mjs /path/to/actual/workspace
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createBackgroundService } from "../src/background.js";
import { createCronService } from "../src/cron.js";
import { importLegacyGoal } from "../src/goal-compat.js";
import { createReminderService } from "../src/reminders.js";

const workspace = resolve(
	process.argv[2] ||
		(() => {
			throw new Error("Provide actual workspace path");
		})()
);
const clone = mkdtempSync(join(tmpdir(), "issue28-state-clone-"));
const services = [];
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const forbidden = async () => {
	throw new Error("Compatibility rehearsal cannot execute or send");
};
try {
	for (const [file, table, create] of [
		["background.db", "jobs", createBackgroundService],
		["reminders.db", "reminders", createReminderService],
	]) {
		const path = join(workspace, file);
		if (!existsSync(path)) continue;
		const source = new Database(path, { readonly: true, fileMustExist: true });
		try {
			assert.equal(source.pragma("quick_check", { simple: true }), "ok");
			const before = source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
			await source.backup(join(clone, file));
			const service = create({ workingDir: clone, summarize: forbidden, deliver: forbidden });
			services.push(service);
			assert.equal(service.list().length, before.length);
			const copy = new Database(join(clone, file), { readonly: true });
			try {
				assert.deepEqual(copy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before);
			} finally {
				copy.close();
			}
			console.log(`ok - ${file}: ${before.length} existing records unchanged, new history table compatible`);
		} finally {
			source.close();
		}
	}
	mkdirSync(join(clone, "cron"));
	for (const file of ["jobs.json", "runs.jsonl"]) {
		const path = join(workspace, "cron", file);
		if (existsSync(path)) copyFileSync(path, join(clone, "cron", file));
	}
	const cronDatabase = join(workspace, "cron/scheduler.db");
	if (existsSync(cronDatabase)) {
		const source = new Database(cronDatabase, { readonly: true, fileMustExist: true });
		try {
			await source.backup(join(clone, "cron/scheduler.db"));
		} finally {
			source.close();
		}
	}
	const cron = createCronService({ workingDir: clone, execute: forbidden });
	services.push(cron);
	const configPath = join(workspace, "cron/jobs.json");
	if (existsSync(configPath))
		assert.equal(cron.list().length, JSON.parse(readFileSync(configPath, "utf8")).jobs.length);
	const historyPath = join(workspace, "cron/runs.jsonl");
	if (!existsSync(cronDatabase) && existsSync(historyPath)) {
		const expected = new Map();
		for (const line of readFileSync(historyPath, "utf8").split("\n").filter(Boolean)) {
			try {
				const record = JSON.parse(line);
				if (record.id) expected.set(record.id, record);
			} catch {
				/* partial legacy record */
			}
		}
		const imported = new Map(cron.listRuns(expected.size + 1).map((record) => [record.id, record]));
		assert.equal(imported.size, expected.size);
		for (const [id, record] of expected) assert.deepEqual(imported.get(id), record);
	}
	console.log(`ok - cron: ${cron.list().length} jobs retained; existing history imports without execution`);
	let goals = 0;
	for (const entry of readdirSync(workspace, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const original = join(workspace, entry.name, "goal.json");
		if (!existsSync(original)) continue;
		const before = digest(original);
		const directory = join(clone, basename(entry.name));
		mkdirSync(directory);
		copyFileSync(original, join(directory, "goal.json"));
		importLegacyGoal(directory, (goal) => {
			assert.ok(["paused", "blocked"].includes(goal.status));
			assert.equal(goal.autoContinue, false);
			goals++;
		});
		assert.equal(digest(original), before);
	}
	console.log(`ok - ${goals} nonempty legacy goals validate and import paused/blocked; originals unchanged`);
	console.log("PASS production-state compatibility rehearsal; no workers started or sends attempted");
} finally {
	await Promise.allSettled(services.map((service) => service.stop()));
	rmSync(clone, { recursive: true, force: true });
}
