import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import { Cron } from "croner";

export interface AutomationJob {
	id: string;
	name: string;
	enabled: boolean;
	schedule: string;
	timezone: string;
	timeoutSeconds: number;
	argv: string[];
	cwd?: string;
	chatGuid?: string;
	dailySummary?: boolean;
}
export interface DriverResult {
	status: "healthy" | "needs_human" | "failed";
	summary: string;
	reason?: string;
}
interface TaskRow {
	id: string;
	state: string;
	paused: number;
	blocked: number;
	lastSuccess: string | null;
	nextRun: string | null;
	reason: string;
	incident: number;
}
export interface AutomationRun {
	id: number;
	taskId: string;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	summary: string;
	reason: string;
}
export interface AutomationView extends TaskRow {
	name: string;
	enabled: boolean;
	running: boolean;
	notification: string;
}
export interface AutomationService {
	start(): void;
	stop(): Promise<void>;
	list(): AutomationView[];
	listRuns(): AutomationRun[];
	action(id: string, action: "run" | "pause" | "resume"): void;
}
export const SAFE_TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function parseAutomationConfig(raw: string): AutomationJob[] {
	try {
		const input = JSON.parse(raw);
		if (input?.version !== 1 || !Array.isArray(input.jobs) || input.jobs.length > 100) throw new Error();
		const ids = new Set<string>();
		return input.jobs.map((job: AutomationJob) => {
			if (
				!job ||
				typeof job.id !== "string" ||
				!SAFE_TASK_ID.test(job.id) ||
				ids.has(job.id) ||
				typeof job.name !== "string" ||
				!job.name ||
				job.name.length > 120 ||
				typeof job.enabled !== "boolean" ||
				typeof job.schedule !== "string" ||
				typeof job.timezone !== "string" ||
				!Number.isFinite(job.timeoutSeconds) ||
				job.timeoutSeconds <= 0 ||
				job.timeoutSeconds > 3600 ||
				!Array.isArray(job.argv) ||
				!job.argv.length ||
				job.argv.length > 100 ||
				job.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
				!isAbsolute(job.argv[0]) ||
				(job.cwd !== undefined && (typeof job.cwd !== "string" || !isAbsolute(job.cwd))) ||
				(job.chatGuid !== undefined && typeof job.chatGuid !== "string") ||
				(job.dailySummary !== undefined && typeof job.dailySummary !== "boolean")
			)
				throw new Error();
			ids.add(job.id);
			new Cron(job.schedule, { timezone: job.timezone, paused: true }).stop();
			return {
				id: job.id,
				name: job.name,
				enabled: job.enabled,
				schedule: job.schedule,
				timezone: job.timezone,
				timeoutSeconds: job.timeoutSeconds,
				argv: [...job.argv],
				cwd: job.cwd,
				chatGuid: job.chatGuid,
				dailySummary: job.dailySummary === true,
			};
		});
	} catch {
		throw new Error("Invalid reviewed automation configuration");
	}
}

function clean(text: string): string {
	return text
		.split("")
		.map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character))
		.join("")
		.replace(/\b(password|token|cookie|authorization|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.slice(0, 500);
}
export function parseDriverResult(output: string): DriverResult {
	try {
		const value = JSON.parse(output.trimEnd().split("\n").at(-1) ?? "");
		if (
			!value ||
			!["healthy", "needs_human", "failed"].includes(value.status) ||
			typeof value.summary !== "string" ||
			(value.reason !== undefined && typeof value.reason !== "string") ||
			Object.keys(value).some((key) => !["status", "summary", "reason"].includes(key))
		)
			throw new Error();
		return {
			status: value.status,
			summary: clean(value.summary),
			...(value.reason === undefined ? {} : { reason: clean(value.reason) }),
		};
	} catch {
		return { status: "failed", summary: "Invalid driver result", reason: "Driver must emit a final JSON result" };
	}
}

function groupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function terminateGroup(pid: number): Promise<boolean> {
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(-pid, signal);
		} catch {
			/* Verify absence below; never expose OS errors. */
		}
		for (let attempt = 0; attempt < 20; attempt++) {
			if (!groupExists(pid)) return true;
			await sleep(50);
		}
	}
	return !groupExists(pid);
}

export function createAutomationService(config: {
	workingDir: string;
	/** Resolving means sender accepted the request, NOT verified delivery. */
	notify?: (chatGuid: string, text: string) => Promise<void>;
	now?: () => Date;
}): AutomationService {
	const directory = join(config.workingDir, "automation");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "jobs.json");
	const jobs = existsSync(path) ? parseAutomationConfig(readFileSync(path, "utf8")) : [];
	const db = new Database(join(directory, "automation.db"));
	db.pragma("journal_mode = WAL");
	db.exec(`CREATE TABLE IF NOT EXISTS tasks (
		id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'idle', paused INTEGER NOT NULL DEFAULT 0,
		blocked INTEGER NOT NULL DEFAULT 0, lastSuccess TEXT, nextRun TEXT, reason TEXT NOT NULL DEFAULT '', incident INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL,
		startedAt TEXT NOT NULL, finishedAt TEXT, summary TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', pid INTEGER);
		CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, taskId TEXT NOT NULL, text TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, retryAt INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE IF NOT EXISTS digest_days (day TEXT NOT NULL, chat TEXT NOT NULL, PRIMARY KEY(day,chat));`);
	for (const job of jobs) db.prepare("INSERT OR IGNORE INTO tasks(id) VALUES (?)").run(job.id);
	const active = new Map<string, { cancel: (reason: string) => void; done: Promise<void> }>();
	const schedules = new Map<string, Cron>();
	let started = false;
	let closed = false;
	let workerLock: Database.Database | undefined;
	let retryTimer: ReturnType<typeof setInterval> | undefined;
	let sending: Promise<void> | undefined;
	const row = (id: string) => db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow;
	const timestamp = () => new Date().toISOString();

	function incident(job: AutomationJob, result: DriverResult): void {
		const previous = row(job.id).incident;
		const failing = result.status !== "healthy";
		if (failing === Boolean(previous)) return;
		db.prepare("UPDATE tasks SET incident=? WHERE id=?").run(Number(failing), job.id);
		db.prepare("INSERT INTO notifications(taskId,text) VALUES (?,?)").run(
			job.id,
			`${job.name}: ${failing ? "action needed" : "recovered"}. ${result.summary}`
		);
	}
	function queueDailySummaries(): void {
		const now = config.now?.() ?? new Date();
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Shanghai",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		}).formatToParts(now);
		const part = (key: string) => parts.find((item) => item.type === key)?.value ?? "";
		if (Number(part("hour")) < 21) return;
		const day = `${part("year")}-${part("month")}-${part("day")}`;
		const since = new Date(`${day}T00:00:00+08:00`).toISOString();
		const groups = new Map<string, AutomationJob[]>();
		for (const job of jobs) {
			if (!job.dailySummary || !job.chatGuid) continue;
			groups.set(job.chatGuid, [...(groups.get(job.chatGuid) ?? []), job]);
		}
		for (const [chat, members] of groups)
			db.transaction(() => {
				if (!db.prepare("INSERT OR IGNORE INTO digest_days(day,chat) VALUES (?,?)").run(day, chat).changes) return;
				const lines = members.map((job) => {
					const counts = db
						.prepare("SELECT status,COUNT(*) AS count FROM runs WHERE taskId=? AND startedAt>=? GROUP BY status")
						.all(job.id, since) as { status: string; count: number }[];
					const count = (status: string) => counts.find((item) => item.status === status)?.count ?? 0;
					const task = row(job.id);
					return `${job.name}：成功 ${count("healthy")}，失败 ${count("failed")}，需人工 ${count("needs_human")}；当前 ${task.state}${task.paused ? "（暂停）" : ""}。`;
				});
				db.prepare("INSERT INTO notifications(taskId,text) VALUES (?,?)").run(
					members[0].id,
					`${day} 任务运行汇总\n${lines.join("\n")}`
				);
			})();
	}
	async function flushNotifications(): Promise<void> {
		if (!started || !config.notify) return;
		queueDailySummaries();
		const pending = db
			.prepare(
				"SELECT id,taskId,text,attempts FROM notifications WHERE status='pending' AND attempts<3 AND retryAt<=? ORDER BY id LIMIT 10"
			)
			.all(Date.now()) as { id: number; taskId: string; text: string; attempts: number }[];
		for (const notice of pending) {
			if (!started) return;
			const job = jobs.find((job) => job.id === notice.taskId);
			if (!job?.chatGuid) continue;
			db.prepare("UPDATE notifications SET attempts=attempts+1,retryAt=? WHERE id=?").run(
				Date.now() + 60_000,
				notice.id
			);
			try {
				await config.notify(job.chatGuid, `${notice.text}\n〔任务通知 ${notice.id}〕`);
				db.prepare("UPDATE notifications SET status='accepted' WHERE id=?").run(notice.id);
			} catch {
				/* Pending, bounded retry. Sender errors may contain private data. */
			}
		}
	}
	function notifyLater(): void {
		if (!sending)
			sending = flushNotifications()
				.catch(() => {})
				.finally(() => {
					sending = undefined;
				});
	}
	function next(job: AutomationJob): void {
		db.prepare("UPDATE tasks SET nextRun=? WHERE id=?").run(
			schedules.get(job.id)?.nextRun()?.toISOString() ?? null,
			job.id
		);
	}

	async function execute(job: AutomationJob, runId: number, controller: AbortController): Promise<void> {
		let result: DriverResult = { status: "failed", summary: "Driver failed" };
		let verified = true;
		let pid: number | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (controller.signal.aborted) throw new Error("Cancelled before spawn");
			const child = spawn(job.argv[0], job.argv.slice(1), {
				shell: false,
				detached: true,
				cwd: job.cwd,
				stdio: ["ignore", "pipe", "ignore"],
			});
			pid = child.pid;
			if (pid) db.prepare("UPDATE runs SET pid=? WHERE id=?").run(pid, runId);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output = (output + chunk.toString("utf8")).slice(-8192);
			});
			const exit = new Promise<number | null>((resolve) => {
				child.once("error", () => resolve(null));
				child.once("close", (code) => resolve(code));
			});
			let cancelResolve: (() => void) | undefined;
			const cancelled = new Promise<void>((resolve) => {
				cancelResolve = resolve;
			});
			controller.signal.addEventListener("abort", () => cancelResolve?.(), { once: true });
			if (controller.signal.aborted) cancelResolve?.();
			timer = setTimeout(() => controller.abort("Timed out"), job.timeoutSeconds * 1000);
			const code = await Promise.race([exit, cancelled]);
			if (controller.signal.aborted)
				result = { status: "failed", summary: "Run cancelled", reason: String(controller.signal.reason) };
			else if (code === 0) result = parseDriverResult(output);
			if (pid && groupExists(pid)) {
				verified = await terminateGroup(pid);
				if (!controller.signal.aborted) result = { status: "failed", summary: "Driver left active processes" };
			}
			// Group absence is required even after child close; never unlock on a timer alone.
			if (verified) await exit;
		} catch {
			result = { status: "failed", summary: "Driver could not execute" };
			if (pid) verified = await terminateGroup(pid);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (controller.signal.aborted)
			result = { status: "failed", summary: "Run cancelled", reason: String(controller.signal.reason) };
		if (!verified)
			result = {
				status: "failed",
				summary: "Termination unverified",
				reason: "Operator must verify process tree before rerun",
			};
		// Reviewed drivers must emit only public summaries. Also redact known private config values.
		for (const secret of [job.chatGuid, job.cwd, ...job.argv].filter((value): value is string =>
			Boolean(value && value.length > 3)
		)) {
			result.summary = result.summary.split(secret).join("[redacted]");
			if (result.reason) result.reason = result.reason.split(secret).join("[redacted]");
		}
		db.transaction(() => {
			db.prepare("UPDATE runs SET status=?,finishedAt=?,summary=?,reason=? WHERE id=?").run(
				result.status,
				timestamp(),
				result.summary,
				result.reason ?? "",
				runId
			);
			const paused =
				row(job.id).paused ||
				result.status === "needs_human" ||
				!verified ||
				controller.signal.reason === "Worker stopped";
			db.prepare(
				"UPDATE tasks SET state=?,paused=?,blocked=?,reason=?,lastSuccess=CASE WHEN ?='healthy' THEN ? ELSE lastSuccess END WHERE id=?"
			).run(
				result.status,
				Number(Boolean(paused)),
				Number(!verified),
				result.reason || result.summary,
				result.status,
				timestamp(),
				job.id
			);
			incident(job, result);
		})();
		notifyLater();
	}
	function begin(job: AutomationJob, resume = false): void {
		const task = row(job.id);
		if (!started || closed || !job.enabled || task.blocked || active.has(job.id) || (!resume && task.paused))
			throw new Error("Task unavailable; paused tasks require Resume");
		const controller = new AbortController();
		const runId = Number(
			db.prepare("INSERT INTO runs(taskId,status,startedAt) VALUES (?,'running',?)").run(job.id, timestamp())
				.lastInsertRowid
		);
		// Resume is verification, not a healthy declaration. Failed verification stays paused.
		db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(job.id);
		const done = Promise.resolve()
			.then(() => execute(job, runId, controller))
			.then(() => {
				if (resume && row(job.id).state === "healthy") db.prepare("UPDATE tasks SET paused=0 WHERE id=?").run(job.id);
			})
			.catch(() => {
				db.prepare(
					"UPDATE tasks SET state='failed',paused=1,blocked=1,reason='Internal automation failure' WHERE id=?"
				).run(job.id);
			})
			.finally(() => active.delete(job.id));
		active.set(job.id, { cancel: (reason) => controller.abort(reason), done });
	}
	return {
		start() {
			if (started) return;
			if (closed) throw new Error("Automation service closed");
			if (process.platform === "win32") throw new Error("Automation requires POSIX process groups");
			// Separate SQLite transaction is an OS-backed lifetime lock; it cannot leave
			// stale PID files, and does not block reads/writes of the task database.
			const lock = new Database(join(directory, "worker-lock.db"));
			try {
				lock.pragma("busy_timeout = 0");
				lock.exec("BEGIN EXCLUSIVE");
				workerLock = lock;
			} catch {
				lock.close();
				throw new Error("Another automation worker owns this workspace");
			}
			started = true;
			// Do not kill persisted PIDs (PID reuse). Interrupted checks require manual verification.
			for (const interrupted of db.prepare("SELECT id,taskId,pid FROM runs WHERE status='running'").all() as {
				id: number;
				taskId: string;
				pid: number | null;
			}[]) {
				const blocked = !interrupted.pid || groupExists(interrupted.pid);
				db.prepare(
					"UPDATE runs SET status='failed',finishedAt=?,summary='Interrupted by restart',reason='Manual verification required' WHERE id=?"
				).run(timestamp(), interrupted.id);
				db.prepare(
					"UPDATE tasks SET state='failed',paused=1,blocked=?,reason='Interrupted; verify previous process tree' WHERE id=?"
				).run(Number(blocked), interrupted.taskId);
				const job = jobs.find((job) => job.id === interrupted.taskId);
				if (job) incident(job, { status: "failed", summary: "Interrupted by restart" });
			}
			for (const job of jobs) {
				if (!job.enabled) continue;
				const due = row(job.id).nextRun;
				const schedule = new Cron(job.schedule, { timezone: job.timezone, unref: true }, () => {
					next(job);
					try {
						begin(job);
					} catch {
						/* Paused or overlapping: no replay. */
					}
				});
				schedules.set(job.id, schedule);
				next(job);
				if (due && due <= timestamp()) {
					try {
						begin(job);
					} catch {
						/* At most one catch-up. */
					}
				}
			}
			retryTimer = setInterval(notifyLater, 60_000);
			retryTimer.unref();
			notifyLater();
		},
		async stop() {
			if (closed) return;
			started = false;
			closed = true;
			clearInterval(retryTimer);
			for (const schedule of schedules.values()) schedule.stop();
			for (const run of active.values()) run.cancel("Worker stopped");
			await Promise.all([...active.values()].map((run) => run.done));
			await sending;
			db.close();
			workerLock?.close();
			workerLock = undefined;
		},
		list() {
			return jobs.map((job) => {
				const task = row(job.id);
				const notice = db
					.prepare(
						"SELECT status FROM notifications WHERE taskId=? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,id DESC LIMIT 1"
					)
					.get(job.id) as { status: string } | undefined;
				return {
					id: task.id,
					state: task.state,
					paused: task.paused,
					blocked: task.blocked,
					lastSuccess: task.lastSuccess,
					nextRun: task.nextRun,
					reason: task.reason,
					incident: task.incident,
					name: job.name,
					enabled: job.enabled,
					running: active.has(job.id),
					notification: notice?.status ?? "none",
				};
			});
		},
		listRuns() {
			return (
				db
					.prepare("SELECT id,taskId,status,startedAt,finishedAt,summary,reason FROM runs ORDER BY id DESC LIMIT 100")
					.all() as AutomationRun[]
			).filter((run) => jobs.some((job) => job.id === run.taskId));
		},
		action(id, action) {
			const job = jobs.find((job) => job.id === id && SAFE_TASK_ID.test(id));
			if (!job) throw new Error("Unknown task");
			if (!started || closed) throw new Error("Worker inactive");
			if (action === "pause") {
				db.prepare("UPDATE tasks SET paused=1 WHERE id=?").run(id);
				active.get(id)?.cancel("Manually paused");
			} else begin(job, action === "resume");
		},
	};
}
