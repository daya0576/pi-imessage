import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";

export interface BackgroundJob {
	id: string;
	chatGuid: string;
	completionFile: string;
	instruction: string;
	state: "pending" | "summarizing" | "ready" | "done" | "failed";
	deadline: number;
	attempts: number;
	nextAttempt: number;
	summary: string | null;
}
export interface BackgroundInput {
	chatGuid: string;
	completionFile: string;
	instruction: string;
	waitMinutes?: number;
}
export interface BackgroundConfig {
	workingDir: string;
	summarize: (job: BackgroundJob) => Promise<string>;
	deliver: (chatGuid: string, text: string) => Promise<void>;
	now?: () => number;
}
/** Completion markers must live in this chat's scratch, not arbitrary host files. Recheck symlinks at use time. */
export function validateCompletionFile(root: string, chatGuid: string, file: string): string {
	if (!chatGuid || chatGuid === "." || chatGuid === ".." || /[/\\]/.test(chatGuid))
		throw new Error("Invalid chat identifier");
	const base = resolve(root, chatGuid, "scratch");
	const path = resolve(root, file);
	const rel = relative(base, path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel) || !path.endsWith(".json"))
		throw new Error("Completion JSON must be inside this chat's scratch directory");
	mkdirSync(base, { recursive: true });
	let ancestor = path;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const realRelative = relative(realpathSync(base), realpathSync(ancestor));
	if (realRelative.startsWith("..") || isAbsolute(realRelative))
		throw new Error("Completion path escapes chat scratch through a symlink");
	return path;
}
export function createBackgroundService(config: BackgroundConfig) {
	mkdirSync(config.workingDir, { recursive: true });
	const db = new Database(join(config.workingDir, "background.db"));
	db.pragma("journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chatGuid TEXT NOT NULL, completionFile TEXT NOT NULL,
		instruction TEXT NOT NULL, state TEXT NOT NULL, deadline INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
		nextAttempt INTEGER NOT NULL DEFAULT 0, summary TEXT, UNIQUE(chatGuid,completionFile))`);
	const now = config.now ?? Date.now;
	let lock: Database.Database | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let active: Promise<void> | undefined;
	const list = () => db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as BackgroundJob[];
	function create(input: BackgroundInput): BackgroundJob {
		const file = validateCompletionFile(config.workingDir, input.chatGuid, input.completionFile);
		if (!input.instruction.trim() || input.instruction.length > 4000)
			throw new Error("A bounded summary instruction is required");
		const minutes = input.waitMinutes ?? 120;
		if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error("waitMinutes must be 1–1440");
		const existing = db.prepare("SELECT * FROM jobs WHERE chatGuid=? AND completionFile=?").get(input.chatGuid, file) as
			| BackgroundJob
			| undefined;
		if (existing) {
			if (existing.instruction !== input.instruction)
				throw new Error("Completion file already registered with a different instruction; use a fresh run path");
			return existing;
		}
		const id = randomUUID();
		db.prepare(
			"INSERT INTO jobs(id,chatGuid,completionFile,instruction,state,deadline) VALUES (?,?,?,?, 'pending', ?)"
		).run(id, input.chatGuid, file, input.instruction, now() + minutes * 60_000);
		return db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as BackgroundJob;
	}
	async function work(): Promise<void> {
		for (const job of list()) {
			if (!lock) return;
			if (["done", "failed"].includes(job.state) || job.nextAttempt > now()) continue;
			try {
				if (job.state === "pending") {
					const path = validateCompletionFile(config.workingDir, job.chatGuid, job.completionFile);
					let complete = false;
					if (existsSync(path)) {
						const stat = statSync(path);
						if (!stat.isFile() || stat.size > 64_000) throw new Error("Invalid completion marker");
						try {
							const value = JSON.parse(readFileSync(path, "utf8"));
							complete = Boolean(value && typeof value === "object" && !Array.isArray(value));
						} catch {
							/* Atomic completion has not been observed yet. */
						}
					}
					if (!complete) {
						if (now() < job.deadline) continue;
						job.summary = "后台任务等待完成标记超时，尚未确认完成；未自动重跑任务。";
					} else {
						db.prepare("UPDATE jobs SET state='summarizing' WHERE id=?").run(job.id);
						job.summary = await config.summarize(job);
						if (!job.summary.trim() || job.summary.length > 24_000) throw new Error("No bounded background summary");
					}
					db.prepare("UPDATE jobs SET state='ready',summary=?,attempts=0 WHERE id=?").run(job.summary, job.id);
					job.state = "ready";
					job.attempts = 0;
				}
				if (job.state === "ready") {
					await config.deliver(job.chatGuid, `${job.summary}\n后台任务 ${job.id.slice(0, 8)}`);
					db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id);
				}
			} catch {
				const attempts = job.attempts + 1;
				// Read-only summaries may safely retry. Never restart the actual background command.
				if (attempts >= 3 && job.state !== "ready") {
					db.prepare("UPDATE jobs SET state='ready',summary=?,attempts=0,nextAttempt=? WHERE id=?").run(
						"后台任务的自动汇总失败；已保留任务记录，未重跑原任务。",
						now() + 30_000,
						job.id
					);
				} else {
					db.prepare("UPDATE jobs SET state=?,attempts=?,nextAttempt=? WHERE id=?").run(
						attempts >= 10 ? "failed" : job.state === "ready" ? "ready" : "pending",
						attempts,
						now() + Math.min(300_000, 30_000 * attempts),
						job.id
					);
				}
				console.error(`[background] ${job.id} ${job.state} attempt ${attempts} failed; details withheld`);
			}
		}
	}
	function tick(): Promise<void> {
		if (!lock) return Promise.resolve();
		if (!active)
			active = work().finally(() => {
				active = undefined;
			});
		return active;
	}
	function start() {
		if (lock) return;
		const candidate = new Database(join(config.workingDir, "background-worker.lock.db"), { timeout: 0 });
		try {
			candidate.exec("BEGIN EXCLUSIVE");
		} catch (error) {
			candidate.close();
			throw error;
		}
		lock = candidate;
		// Previous process may have died during a read-only summary or uncertain notification.
		db.prepare("UPDATE jobs SET state='pending' WHERE state='summarizing'").run();
		timer = setInterval(() => {
			void tick().catch(() => console.error("[background] poll failed"));
		}, 5000);
		timer.unref();
		void tick().catch(() => console.error("[background] initial poll failed"));
	}
	async function stop() {
		if (!db.open) return;
		if (timer) clearInterval(timer);
		await active;
		if (lock) {
			lock.exec("ROLLBACK");
			lock.close();
			lock = undefined;
		}
		db.close();
	}
	return { create, list, start, stop, tick };
}
export type BackgroundService = ReturnType<typeof createBackgroundService>;
