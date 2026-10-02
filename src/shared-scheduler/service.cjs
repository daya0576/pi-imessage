// Shared, session-independent service API. No resources are started on import.
// The host supplies its installed SQLite/Croner constructors and transport callbacks.
// Interactive index.ts intentionally retains its session-bound scheduling contract.
const { randomUUID } = require("node:crypto");
const {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
	renameSync,
	appendFileSync,
	watch,
} = require("node:fs");
const { join, resolve, relative, isAbsolute, dirname, basename } = require("node:path");
const { parseWhen, parseDuration, formatDuration } = require("./time.cjs");
const MAX_DELAY = 2147000000;
const TERMINAL = new Set(["success", "completed", "failed", "cancelled", "timeout"]);
const SHUTDOWN = new Error("aborted by service shutdown; not replayed");

// One submission text for terminal and service loops: the iteration must know its cancel id.
function loopPrompt(task) {
	return task.intervalMs
		? `[LOOP id=${task.id} every ${formatDuration(task.intervalMs)}]\n${task.prompt}\n\nAfter completing this iteration, check any explicit stop condition in the task. If it is satisfied, call cancel_scheduled_task with id=${task.id}. Otherwise leave the loop running.`
		: task.prompt;
}

function validateCompletionFile(root, chatGuid, file) {
	if (!chatGuid || chatGuid === "." || chatGuid === ".." || /[/\\]/.test(chatGuid))
		throw new Error("Invalid chat identifier");
	const base = resolve(root, chatGuid, "scratch");
	const path = resolve(root, file);
	const rel = relative(base, path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel) || !path.endsWith(".json"))
		throw new Error("Completion JSON must be inside this chat's scratch directory");
	mkdirSync(base, { recursive: true });
	// Also reject a symlinked scratch root; comparing against its realpath alone
	// would allow the entire scratch directory to point outside the workspace.
	if (realpathSync(base) !== resolve(realpathSync(root), chatGuid, "scratch"))
		throw new Error("Chat scratch escapes its owner through a symlink");
	let ancestor = path;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const realRelative = relative(realpathSync(base), realpathSync(ancestor));
	if (realRelative.startsWith("..") || isAbsolute(realRelative))
		throw new Error("Completion path escapes chat scratch through a symlink");
	return path;
}
function parseReminderTime(value) {
	if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new Error("scheduledAt must be ISO 8601 with an explicit timezone");
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error("scheduledAt is not a valid ISO 8601 timestamp");
	return timestamp;
}
// Terminal adapter: retain session ownership, store format and pause/resume policy.
// No SQLite/Croner dependency or timers on import.
function createSessionScheduler(config) {
	const { getActive, getTasks, setTasks, storePath, updateWidget, preview, sendUserMessage } = config;
	const timers = new Map();
	function loadStore() {
		try {
			const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
			if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
		} catch {
			/* Legacy missing/corrupt store behavior. */
		}
		return [];
	}
	function persist() {
		const sessionFile = getActive()?.sessionFile ?? null;
		if (!sessionFile) return;
		const others = loadStore().filter((task) => task.sessionFile !== sessionFile);
		const path = storePath();
		const temporary = `${path}.tmp-${process.pid}`;
		try {
			writeFileSync(temporary, JSON.stringify({ version: 1, tasks: [...others, ...getTasks()] }, null, 2));
			renameSync(temporary, path);
		} catch {
			try {
				rmSync(temporary, { force: true });
			} catch {
				/* Legacy best-effort persistence. */
			}
		}
	}
	function disarmAll() {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	}
	function arm(task) {
		clearTimeout(timers.get(task.id));
		const delay = task.fireAt - Date.now();
		const timer = setTimeout(
			() => {
				if (delay <= 0 || Date.now() >= task.fireAt - 50) fire(task);
				else arm(task);
			},
			delay <= 0 ? 1500 : Math.min(delay, 2147483647)
		);
		timer.unref();
		timers.set(task.id, timer);
	}
	function fire(task) {
		timers.delete(task.id);
		if (task.intervalMs && task.intervalMs > 0) {
			task.fireAt = Date.now() + task.intervalMs;
			arm(task);
		} else setTasks(getTasks().filter((item) => item.id !== task.id));
		persist();
		updateWidget();
		const ctx = getActive()?.ctx;
		if (!ctx) return;
		if (ctx.hasUI)
			ctx.ui.notify(
				`⏰ ${task.intervalMs ? "Running loop iteration" : "Running scheduled task"}: ${preview(task.prompt)}`,
				"info"
			);
		const prompt = loopPrompt(task);
		try {
			if (ctx.isIdle?.()) sendUserMessage(prompt);
			else sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch {
			sendUserMessage(prompt, { deliverAs: "followUp" });
		}
	}
	function create(spec, prompt, ctx, loop) {
		const timestamp = Date.now();
		const intervalMs = loop ? parseDuration(spec.trim()) : undefined;
		if (loop && intervalMs == null)
			throw new Error(`invalid interval "${spec}" — use a duration like 30s, 5m, 1h, 1h30m, 2d`);
		if (loop && intervalMs <= 0) throw new Error("interval must be positive");
		const fireAt = loop ? timestamp : parseWhen(spec, timestamp);
		if (!loop && fireAt <= Date.now()) throw new Error("that time is in the past");
		const cleaned = prompt.trim();
		if (!cleaned) throw new Error("a prompt is required");
		const task = {
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			prompt: cleaned,
			fireAt,
			createdAt: Date.now(),
			sessionFile: getActive()?.sessionFile ?? null,
			cwd: ctx.cwd,
		};
		if (loop) task.intervalMs = intervalMs;
		setTasks([...getTasks(), task]);
		persist();
		arm(task);
		updateWidget();
		return task;
	}
	function cancel(id) {
		const task = getTasks().find((task) => task.id === id);
		if (!task) return null;
		setTasks(getTasks().filter((task) => task.id !== id));
		clearTimeout(timers.get(id));
		timers.delete(id);
		persist();
		updateWidget();
		return task;
	}
	return {
		loadStore,
		persist,
		disarmAll,
		arm,
		cancel,
		scheduleTask: (spec, prompt, ctx) => create(spec, prompt, ctx, false),
		scheduleLoop: (spec, prompt, ctx) => create(spec, prompt, ctx, true),
	};
}
function createServiceBackend({ Database, Cron }) {
	function open(path) {
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path);
		db.pragma("journal_mode = WAL");
		return db;
	}
	// A separate SQLite file holds a lifetime exclusive transaction. OS teardown
	// releases this fence on crash; never stale PID files or competing pollers.
	function fence(path) {
		let lock;
		return {
			acquire() {
				if (lock) return;
				const candidate = new Database(path, { timeout: 0 });
				try {
					candidate.exec("BEGIN EXCLUSIVE");
				} catch (error) {
					candidate.close();
					throw error;
				}
				lock = candidate;
			},
			release() {
				if (lock) {
					lock.exec("ROLLBACK");
					lock.close();
					lock = undefined;
				}
			},
		};
	}
	function createBackgroundService(config) {
		const db = open(join(config.workingDir, "background.db"));
		db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chatGuid TEXT NOT NULL, completionFile TEXT NOT NULL,
      instruction TEXT NOT NULL, state TEXT NOT NULL, deadline INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      nextAttempt INTEGER NOT NULL DEFAULT 0, summary TEXT, UNIQUE(chatGuid,completionFile));
      CREATE TABLE IF NOT EXISTS background_history (sequence INTEGER PRIMARY KEY, jobId TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);`);
		const now = config.now || Date.now;
		const worker = fence(join(config.workingDir, "background-worker.lock.db"));
		let started = false;
		let stopping = false;
		let timer;
		let active;
		const list = () => db.prepare("SELECT * FROM jobs ORDER BY rowid").all();
		const history = (id) =>
			db.prepare("SELECT jobId,state,at FROM background_history WHERE jobId=? ORDER BY sequence").all(id);
		const record = (id, state) =>
			db.prepare("INSERT INTO background_history(jobId,state,at) VALUES (?,?,?)").run(id, state, now());
		const transition = db.transaction((id, state, summary, attempts, nextAttempt) => {
			db.prepare("UPDATE jobs SET state=?,summary=?,attempts=?,nextAttempt=? WHERE id=?").run(
				state,
				summary,
				attempts,
				nextAttempt,
				id
			);
			record(id, state);
		});
		function create(input) {
			const file = validateCompletionFile(config.workingDir, input.chatGuid, input.completionFile);
			if (!input.instruction.trim() || input.instruction.length > 4000)
				throw new Error("A bounded summary instruction is required");
			const minutes = input.waitMinutes ?? 120;
			if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error("waitMinutes must be 1–1440");
			return db.transaction(() => {
				const existing = db
					.prepare("SELECT * FROM jobs WHERE chatGuid=? AND completionFile=?")
					.get(input.chatGuid, file);
				if (existing) {
					if (existing.instruction !== input.instruction)
						throw new Error("Completion file already registered with a different instruction; use a fresh run path");
					return existing;
				}
				const id = randomUUID();
				db.prepare(
					"INSERT INTO jobs(id,chatGuid,completionFile,instruction,state,deadline) VALUES (?,?,?,?,'pending',?)"
				).run(id, input.chatGuid, file, input.instruction, now() + minutes * 60000);
				record(id, "pending");
				return db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
			})();
		}
		async function work() {
			for (const job of list()) {
				if (stopping || !started) break;
				if (["done", "failed"].includes(job.state) || job.nextAttempt > now()) continue;
				try {
					if (job.state === "pending") {
						const path = validateCompletionFile(config.workingDir, job.chatGuid, job.completionFile);
						let complete = false;
						if (existsSync(path)) {
							const stat = statSync(path);
							if (!stat.isFile() || stat.size > 64000) throw new Error("Invalid completion marker");
							try {
								const value = JSON.parse(readFileSync(path, "utf8"));
								complete = value && typeof value === "object" && !Array.isArray(value) && TERMINAL.has(value.status);
							} catch {
								/* Partial/invalid writes are not completion. */
							}
						}
						if (!complete) {
							if (now() < job.deadline) continue;
							job.summary = "后台任务等待完成标记超时，尚未确认完成；未自动重跑任务。";
						} else {
							transition(job.id, "summarizing", null, job.attempts, job.nextAttempt);
							job.summary = await config.summarize(job);
							if (!job.summary.trim() || job.summary.length > 24000) throw new Error("No bounded background summary");
						}
						transition(job.id, "ready", job.summary, 0, 0);
						job.state = "ready";
						job.attempts = 0;
					}
					if (job.state === "ready") {
						// Stable full id lets a capable transport deduplicate uncertain sends.
						await config.deliver(job.chatGuid, `${job.summary}\n后台任务 ${job.id.slice(0, 8)}`, job.id);
						transition(job.id, "done", job.summary, job.attempts, 0);
					}
				} catch {
					const attempts = job.attempts + 1;
					if (attempts >= 3 && job.state !== "ready") {
						transition(job.id, "ready", "后台任务的自动汇总失败；已保留任务记录，未重跑原任务。", 0, now() + 30000);
					} else {
						transition(
							job.id,
							attempts >= 10 ? "failed" : job.state === "ready" ? "ready" : "pending",
							job.summary,
							attempts,
							now() + Math.min(300000, 30000 * attempts)
						);
					}
					console.error(`[background] ${job.id} ${job.state} attempt ${attempts} failed; details withheld`);
				}
			}
		}
		function tick() {
			if (!started || stopping) return Promise.resolve();
			if (!active)
				active = work().finally(() => {
					active = undefined;
				});
			return active;
		}
		function start() {
			if (started) return;
			if (!db.open || stopping) throw new Error("background service is closed");
			worker.acquire();
			started = true;
			// Re-execute only the read-only summary, never the original command.
			for (const job of list().filter((job) => job.state === "summarizing"))
				transition(job.id, "pending", job.summary, job.attempts, job.nextAttempt);
			timer = setInterval(() => void tick().catch(() => console.error("[background] poll failed")), 5000);
			timer.unref();
			void tick().catch(() => console.error("[background] initial poll failed"));
		}
		async function stop() {
			if (!db.open) return;
			stopping = true;
			clearInterval(timer);
			await active;
			started = false;
			worker.release();
			db.close();
		}
		return { create, list, history, start, stop, tick };
	}

	function createReminderService(config) {
		const now = config.now || Date.now;
		const db = open(join(config.workingDir, "reminders.db"));
		db.exec(`CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, chat_guid TEXT NOT NULL, text TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','delivered','cancelled','failed')), attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, delivered_at INTEGER, cancelled_at INTEGER, last_error TEXT,
      idempotency_key TEXT UNIQUE, next_attempt_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS reminder_history (sequence INTEGER PRIMARY KEY, reminderId TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL);`);
		const worker = fence(join(config.workingDir, "reminder-worker.lock.db"));
		const retryBase = config.retryBaseMs ?? 30000;
		const maxAttempts = config.maxAttempts ?? 10;
		let timer;
		let started = false;
		let closed = false;
		let active;
		const rowById = (id) => db.prepare("SELECT * FROM reminders WHERE id=?").get(id);
		const iso = (value) => (value === null ? null : new Date(value).toISOString());
		const map = (row) => ({
			id: row.id,
			chatGuid: row.chat_guid,
			text: row.text,
			scheduledAt: iso(row.scheduled_at),
			status: row.status,
			attempts: row.attempts,
			createdAt: iso(row.created_at),
			deliveredAt: iso(row.delivered_at),
			cancelledAt: iso(row.cancelled_at),
			lastError: row.last_error,
			idempotencyKey: row.idempotency_key,
		});
		const record = (id, status) =>
			db.prepare("INSERT INTO reminder_history(reminderId,status,at) VALUES (?,?,?)").run(id, status, now());
		function schedule() {
			if (!started || active) return;
			clearTimeout(timer);
			const row = db
				.prepare("SELECT * FROM reminders WHERE status='pending' ORDER BY next_attempt_at,created_at LIMIT 1")
				.get();
			if (!row) return;
			timer = setTimeout(
				() => {
					active = processDue()
						.catch((error) => console.error("[reminder] scheduler error:", error))
						.finally(() => {
							active = undefined;
							schedule();
						});
				},
				Math.min(MAX_DELAY, Math.max(0, row.next_attempt_at - now()))
			);
			timer.unref();
		}
		async function processDue() {
			const rows = db
				.prepare(
					"SELECT * FROM reminders WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at"
				)
				.all(now());
			for (const row of rows) {
				if (!started) break;
				// Cancellation by another call may have happened while a previous send awaited.
				const result = db
					.prepare("UPDATE reminders SET attempts=attempts+1,last_error=NULL WHERE id=? AND status='pending'")
					.run(row.id);
				if (!result.changes) continue;
				const current = rowById(row.id);
				record(row.id, "attempt");
				try {
					await config.deliver(map(current));
					db.transaction(() => {
						db.prepare(
							"UPDATE reminders SET status='delivered',delivered_at=?,last_error=NULL WHERE id=? AND status='pending'"
						).run(now(), row.id);
						record(row.id, "delivered");
					})();
					console.log(`[reminder] delivered ${row.id} to ${row.chat_guid}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const failed = current.attempts >= maxAttempts;
					const delay = Math.min(retryBase * 2 ** Math.max(0, current.attempts - 1), 3600000);
					db.prepare(
						"UPDATE reminders SET status=?,next_attempt_at=?,last_error=? WHERE id=? AND status='pending'"
					).run(failed ? "failed" : "pending", now() + delay, message, row.id);
					record(row.id, failed ? "failed" : "retry");
					console.warn(
						`[reminder] ${row.id} attempt ${current.attempts} ${failed ? "failed permanently" : "retry persisted"}: ${message}`
					);
				}
			}
		}
		return {
			start() {
				if (started) return;
				if (closed) throw new Error("reminder service is closed");
				worker.acquire();
				// A crash after an attempt began leaves the external send uncertain: never resend it.
				for (const row of db
					.prepare(
						"SELECT id FROM reminders r WHERE status='pending' AND (SELECT status FROM reminder_history WHERE reminderId=r.id ORDER BY sequence DESC LIMIT 1)='attempt'"
					)
					.all()) {
					db.transaction(() => {
						db.prepare("UPDATE reminders SET status='failed',last_error=? WHERE id=? AND status='pending'").run(
							"interrupted during delivery; outcome unknown; not resent",
							row.id
						);
						record(row.id, "interrupted");
					})();
					console.warn(`[reminder] ${row.id} delivery was interrupted; marked failed, not resent`);
				}
				started = true;
				schedule();
				console.log("[reminder] durable scheduler started");
			},
			async stop() {
				if (closed) return;
				started = false;
				clearTimeout(timer);
				await active;
				worker.release();
				db.close();
				closed = true;
			},
			create(input) {
				const chatGuid = input.chatGuid.trim();
				const text = input.text.trim();
				const key = input.idempotencyKey?.trim() || null;
				if (!chatGuid) throw new Error("chatGuid is required");
				if (!text) throw new Error("text is required");
				const scheduledAt = parseReminderTime(input.scheduledAt);
				const result = db.transaction(() => {
					const existing = key ? db.prepare("SELECT * FROM reminders WHERE idempotency_key=?").get(key) : null;
					if (existing) {
						if (existing.chat_guid !== chatGuid || existing.text !== text || existing.scheduled_at !== scheduledAt)
							throw new Error("idempotencyKey already exists with different reminder data");
						return { reminder: map(existing), created: false };
					}
					const id = randomUUID();
					db.prepare(
						"INSERT INTO reminders(id,chat_guid,text,scheduled_at,status,created_at,idempotency_key,next_attempt_at) VALUES (?,?,?,?,'pending',?,?,?)"
					).run(id, chatGuid, text, scheduledAt, now(), key, scheduledAt);
					record(id, "pending");
					return { reminder: map(rowById(id)), created: true };
				})();
				if (result.created)
					console.log(`[reminder] scheduled ${result.reminder.id} for ${result.reminder.scheduledAt} to ${chatGuid}`);
				schedule();
				return result;
			},
			list(status) {
				return (
					status
						? db.prepare("SELECT * FROM reminders WHERE status=? ORDER BY scheduled_at,created_at").all(status)
						: db.prepare("SELECT * FROM reminders ORDER BY scheduled_at,created_at").all()
				).map(map);
			},
			cancel(id) {
				const result = db
					.prepare("UPDATE reminders SET status='cancelled',cancelled_at=? WHERE id=? AND status='pending'")
					.run(now(), id);
				if (!result.changes) return null;
				record(id, "cancelled");
				console.log(`[reminder] cancelled ${id}`);
				schedule();
				return map(rowById(id));
			},
			history(id) {
				return db
					.prepare("SELECT reminderId,status,at FROM reminder_history WHERE reminderId=? ORDER BY sequence")
					.all(id);
			},
		};
	}

	function parseCronConfig(raw, defaultTimezone = "Asia/Shanghai") {
		const value = JSON.parse(raw);
		if (!value || value.version !== 1 || !Array.isArray(value.jobs))
			throw new Error("cron config must contain version=1 and a jobs array");
		const ids = new Set();
		const string = (value, label) => {
			if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
			return value.trim();
		};
		const jobs = value.jobs.map((input, index) => {
			if (!input || typeof input !== "object") throw new Error(`cron job ${index}: must be an object`);
			const id = string(input.id, `cron job ${index}: id`);
			if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`cron job ${id}: id contains invalid characters`);
			if (ids.has(id)) throw new Error(`duplicate cron job id: ${id}`);
			ids.add(id);
			const schedule = string(input.schedule, `cron job ${id}: schedule`);
			const timezone = input.timezone === undefined ? defaultTimezone : string(input.timezone, "timezone");
			const timeoutSeconds = input.timeoutSeconds === undefined ? 300 : Number(input.timeoutSeconds);
			if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
				throw new Error(`cron job ${id}: timeoutSeconds must be positive`);
			const enabled = input.enabled === undefined ? true : input.enabled;
			if (typeof enabled !== "boolean") throw new Error(`cron job ${id}: enabled must be boolean`);
			const name = input.name === undefined ? undefined : string(input.name, "name");
			const action = input.action;
			if (!action || typeof action !== "object") throw new Error(`cron job ${id}: action must be an object`);
			const type = string(action.type, "action.type");
			let parsed;
			if (type === "send" || type === "prompt") {
				const field = type === "send" ? "text" : "prompt";
				parsed = {
					type,
					chatGuid: string(action.chatGuid, "action.chatGuid"),
					[field]: string(action[field], `action.${field}`),
				};
			} else if (type === "exec") {
				if (!Array.isArray(action.argv) || !action.argv.length || action.argv.some((part) => typeof part !== "string"))
					throw new Error(`cron job ${id}: action.argv must be a non-empty string array`);
				const argv = action.argv.map((part) => part.trim());
				if (argv.some((part) => !part)) throw new Error(`cron job ${id}: action.argv entries cannot be empty`);
				if (!argv[0].startsWith("/")) throw new Error(`cron job ${id}: action.argv[0] must be an absolute path`);
				parsed = { type, argv, cwd: action.cwd === undefined ? undefined : string(action.cwd, "action.cwd") };
			} else throw new Error(`cron job ${id}: unsupported action type ${type}`);
			const validator = new Cron(schedule, { timezone, paused: true });
			validator.stop();
			return { id, name, enabled, schedule, timezone, timeoutSeconds, action: parsed };
		});
		return { version: 1, jobs };
	}

	function createCronService(config) {
		const cronDir = join(config.workingDir, "cron");
		const configPath = join(cronDir, "jobs.json");
		const runsPath = join(cronDir, "runs.jsonl");
		mkdirSync(cronDir, { recursive: true });
		if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify({ version: 1, jobs: [] }, null, 2)}\n`);
		const timezone = config.defaultTimezone || "Asia/Shanghai";
		const now = config.now || (() => new Date());
		let currentConfig = parseCronConfig(readFileSync(configPath, "utf8"), timezone);
		const db = open(join(cronDir, "scheduler.db"));
		db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, jobId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule (jobId TEXT PRIMARY KEY, signature TEXT NOT NULL, nextAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocked (jobId TEXT PRIMARY KEY, reason TEXT NOT NULL);`);
		// Import existing terminal history once; SQLite is authoritative thereafter.
		if (existsSync(runsPath) && db.prepare("SELECT COUNT(*) AS count FROM runs").get().count === 0) {
			db.transaction(() => {
				for (const line of readFileSync(runsPath, "utf8").split("\n").filter(Boolean)) {
					try {
						const run = JSON.parse(line);
						if (run.id)
							db.prepare(
								"INSERT INTO runs(id,jobId,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data"
							).run(run.id, run.jobId, JSON.stringify(run));
					} catch {
						console.warn("[cron] ignored incomplete legacy history line");
					}
				}
			})();
		}
		const worker = fence(join(cronDir, "worker.lock.db"));
		const scheduled = new Map();
		const activeRuns = new Map();
		const controllers = new Map();
		let started = false;
		let closed = false;
		let stopping = false;
		let owned = false;
		let watcher;
		let reloadTimer;
		function own() {
			if (closed || stopping) throw new Error("cron service is closed");
			if (owned) return;
			worker.acquire();
			owned = true;
			// Do not replay interrupted side effects. Persist an explicit uncertain result.
			for (const row of db.prepare("SELECT data FROM runs").all()) {
				const run = JSON.parse(row.data);
				if (run.status === "running") {
					db.prepare("INSERT OR REPLACE INTO blocked(jobId,reason) VALUES (?,?)").run(
						run.jobId,
						"interrupted run; outcome unknown"
					);
					saveRun({
						...run,
						status: "failed",
						finishedAt: now().toISOString(),
						error: "interrupted by service restart; outcome unknown; job blocked, not replayed",
					});
					console.warn(`[cron] ${run.jobId} blocked after interrupted run; operator verification required`);
				}
			}
		}
		function saveRun(run) {
			db.prepare("INSERT INTO runs(id,jobId,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(
				run.id,
				run.jobId,
				JSON.stringify(run)
			);
			// Retain the existing public JSONL history API, including durable run starts.
			appendFileSync(runsPath, `${JSON.stringify(run)}\n`);
		}
		function listRuns(limit = 100) {
			if (!Number.isFinite(limit) || limit <= 0) return [];
			return db
				.prepare("SELECT data FROM runs ORDER BY rowid DESC LIMIT ?")
				.all(Math.floor(limit))
				.map((row) => JSON.parse(row.data));
		}
		function lastRun(id) {
			const row = db.prepare("SELECT data FROM runs WHERE jobId=? ORDER BY rowid DESC LIMIT 1").get(id);
			return row ? JSON.parse(row.data) : null;
		}
		function stopSchedules() {
			for (const cron of scheduled.values()) cron.stop();
			scheduled.clear();
		}
		function nextSchedule(job) {
			const validator = new Cron(job.schedule, { timezone: job.timezone || timezone, paused: true });
			const next = validator.nextRun(now());
			validator.stop();
			return next?.toISOString();
		}
		function scheduleJobs() {
			stopSchedules();
			if (!started) return;
			for (const job of currentConfig.jobs) {
				if (job.enabled === false) {
					db.prepare("DELETE FROM schedule WHERE jobId=?").run(job.id);
					continue;
				}
				if (db.prepare("SELECT jobId FROM blocked WHERE jobId=?").get(job.id)) continue;
				const signature = JSON.stringify(job);
				const stored = db.prepare("SELECT * FROM schedule WHERE jobId=?").get(job.id);
				const nextAt = stored?.signature === signature ? stored.nextAt : nextSchedule(job);
				if (nextAt)
					db.prepare(
						"INSERT INTO schedule(jobId,signature,nextAt) VALUES (?,?,?) ON CONFLICT(jobId) DO UPDATE SET signature=excluded.signature,nextAt=excluded.nextAt"
					).run(job.id, signature, nextAt);
				const cron = new Cron(
					job.schedule,
					{
						timezone: job.timezone || timezone,
						unref: true,
						catch: (error) => console.error(`[cron] uncaught error in ${job.id}:`, error),
					},
					() => scheduledRun(job)
				);
				scheduled.set(job.id, cron);
				// At most one overdue run after downtime, not all missed occurrences.
				if (nextAt && nextAt <= now().toISOString())
					void scheduledRun(job).catch((error) => console.error(`[cron] catch-up failed: ${job.id}`, error));
			}
			console.log(`[cron] loaded ${currentConfig.jobs.length} durable jobs (${scheduled.size} enabled)`);
		}
		function scheduledRun(job) {
			// Advance before side effects; an interrupted prompt/exec is never auto-replayed.
			const nextAt = nextSchedule(job);
			if (nextAt) db.prepare("UPDATE schedule SET nextAt=? WHERE jobId=?").run(nextAt, job.id);
			return beginRun(job, "scheduled");
		}
		function overlap(job, trigger) {
			const timestamp = now().toISOString();
			const run = {
				id: randomUUID(),
				jobId: job.id,
				trigger,
				status: "skipped-overlap",
				startedAt: timestamp,
				finishedAt: timestamp,
				error: "previous run is still active",
			};
			saveRun(run);
			console.warn(`[cron] skipped overlapping run: ${job.id}`);
			return run;
		}
		async function executeJob(job, trigger) {
			const controller = new AbortController();
			controllers.set(job.id, controller);
			let timedOut = false;
			const run = {
				id: randomUUID(),
				jobId: job.id,
				trigger,
				status: "running",
				startedAt: now().toISOString(),
				finishedAt: null,
				error: null,
			};
			saveRun(run);
			console.log(`[cron] run start: ${job.id} trigger=${trigger} action=${job.action.type}`);
			let timeout;
			const timeoutMs = (job.timeoutSeconds ?? 300) * 1000;
			const timeoutPromise = new Promise((_, reject) => {
				timeout = setTimeout(
					() => {
						const error = new Error(`timed out after ${timeoutMs}ms`);
						timedOut = true;
						controller.abort(error);
						reject(error);
					},
					Math.min(MAX_DELAY, timeoutMs)
				);
				timeout.unref();
			});
			// Even if a callback ignores abort, keep its per-job lock until it settles.
			// Returning a timeout is not evidence the side effect/process has stopped.
			const execution = Promise.resolve().then(() => {
				// Shutdown may abort before the callback starts; never start it afterwards.
				controller.signal.throwIfAborted();
				return config.execute(job, controller.signal);
			});
			const settled = execution.then(
				() => undefined,
				() => undefined
			);
			try {
				await Promise.race([execution, timeoutPromise]);
				run.status = "success";
			} catch (error) {
				// A settled shutdown abort is a known outcome; an unsettled timeout is not.
				run.status = timedOut ? "timeout" : "failed";
				run.error =
					!timedOut && controller.signal.reason === SHUTDOWN
						? SHUTDOWN.message
						: error instanceof Error
							? error.message
							: String(error);
			} finally {
				clearTimeout(timeout);
				controllers.delete(job.id);
				run.finishedAt = now().toISOString();
				if (run.status === "timeout")
					db.prepare("INSERT OR REPLACE INTO blocked(jobId,reason) VALUES (?,?)").run(
						job.id,
						"timed-out execution has not settled"
					);
				saveRun(run);
				console.log(`[cron] run end: ${job.id} status=${run.status}`);
			}
			if (run.status === "timeout") {
				// beginRun's result can resolve while execution remains fenced.
				activeRuns.set(
					job.id,
					settled.finally(() => {
						db.prepare("DELETE FROM blocked WHERE jobId=?").run(job.id);
						activeRuns.delete(job.id);
					})
				);
			} else activeRuns.delete(job.id);
			return run;
		}
		function beginRun(job, trigger) {
			own();
			if (activeRuns.has(job.id)) return Promise.resolve(overlap(job, trigger));
			if (db.prepare("SELECT jobId FROM blocked WHERE jobId=?").get(job.id))
				throw new Error(`cron job ${job.id} has an unknown previous outcome; operator verification required`);
			// Install the lock before invoking a potentially synchronous host callback.
			const promise = executeJob(job, trigger);
			activeRuns.set(job.id, promise);
			return promise;
		}
		function reload() {
			const candidate = parseCronConfig(readFileSync(configPath, "utf8"), timezone);
			currentConfig = candidate;
			scheduleJobs();
		}
		function list() {
			return currentConfig.jobs.map((job) => {
				const blocked = Boolean(db.prepare("SELECT jobId FROM blocked WHERE jobId=?").get(job.id));
				return {
					...job,
					enabled: job.enabled !== false,
					timezone: job.timezone || timezone,
					nextRunAt:
						started && !blocked
							? (db.prepare("SELECT nextAt FROM schedule WHERE jobId=?").get(job.id)?.nextAt ?? null)
							: null,
					running: activeRuns.has(job.id),
					blocked,
					lastRun: lastRun(job.id),
				};
			});
		}
		return {
			configPath,
			list,
			listRuns,
			reload,
			start() {
				if (started) return;
				own();
				started = true;
				scheduleJobs();
				watcher = watch(cronDir, (_event, filename) => {
					if (basename(filename?.toString() || "") !== basename(configPath)) return;
					clearTimeout(reloadTimer);
					reloadTimer = setTimeout(() => {
						try {
							reload();
							console.log("[cron] config reloaded");
						} catch (error) {
							console.error("[cron] reload rejected; keeping last valid config:", error.message);
						}
					}, 200);
					reloadTimer.unref();
				});
				watcher.on("error", (error) => console.error("[cron] config watcher error:", error));
			},
			async stop() {
				if (closed) return;
				stopping = true;
				started = false;
				stopSchedules();
				watcher?.close();
				clearTimeout(reloadTimer);
				// Abort cooperative callbacks so a restart does not leave a SIGKILLed, unknown run.
				for (const controller of controllers.values()) controller.abort(SHUTDOWN);
				// Include callbacks still settling after timeouts. Never release the process
				// fence while an uncooperative callback can still mutate the workspace.
				while (activeRuns.size) await Promise.allSettled([...activeRuns.values()]);
				worker.release();
				db.close();
				closed = true;
			},
			runNow(id) {
				const job = currentConfig.jobs.find((item) => item.id === id);
				if (!job) throw new Error(`cron job not found: ${id}`);
				return beginRun(job, "manual");
			},
			setEnabled(id, enabled) {
				own();
				if (!currentConfig.jobs.some((job) => job.id === id)) throw new Error(`cron job not found: ${id}`);
				const next = { version: 1, jobs: currentConfig.jobs.map((job) => (job.id === id ? { ...job, enabled } : job)) };
				const temporary = `${configPath}.tmp-${process.pid}`;
				writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
				renameSync(temporary, configPath);
				currentConfig = next;
				if (!enabled) db.prepare("DELETE FROM schedule WHERE jobId=?").run(id);
				scheduleJobs();
				return list().find((job) => job.id === id);
			},
		};
	}
	function createSchedulerService(config) {
		const now = config.now || Date.now;
		const db = open(join(config.workingDir, "scheduled-prompts.db"));
		db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, prompt TEXT NOT NULL,
      fireAt INTEGER NOT NULL, initialFireAt INTEGER NOT NULL, intervalMs INTEGER, createdAt INTEGER NOT NULL, status TEXT NOT NULL,
      idempotencyKey TEXT UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, runId TEXT, nextAttempt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, taskId TEXT NOT NULL,
      status TEXT NOT NULL, at INTEGER NOT NULL);`);
		const worker = fence(join(config.workingDir, "scheduled-prompts.lock.db"));
		let started = false;
		let closed = false;
		let timer;
		let active;
		const record = (task, id, status) =>
			db.prepare("INSERT INTO history(id,taskId,status,at) VALUES (?,?,?,?)").run(id, task.id, status, now());
		const list = (owner) =>
			owner === undefined
				? db.prepare("SELECT * FROM tasks ORDER BY fireAt,createdAt").all()
				: db.prepare("SELECT * FROM tasks WHERE owner=? ORDER BY fireAt,createdAt").all(owner);
		function arm() {
			if (!started || active) return;
			clearTimeout(timer);
			const task = db.prepare("SELECT * FROM tasks WHERE status='pending' ORDER BY nextAttempt LIMIT 1").get();
			if (!task) return;
			timer = setTimeout(
				() => {
					active = work()
						.catch((error) => console.error("[scheduler] service poll failed:", error))
						.finally(() => {
							active = undefined;
							arm();
						});
				},
				Math.min(MAX_DELAY, Math.max(0, task.nextAttempt - now()))
			);
			timer.unref();
		}
		async function work() {
			for (const row of db
				.prepare("SELECT * FROM tasks WHERE status='pending' AND nextAttempt<=? ORDER BY nextAttempt")
				.all(now())) {
				if (!started) break;
				const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(row.id);
				if (task.status !== "pending") continue;
				const runId = task.runId || randomUUID();
				db.transaction(() => {
					db.prepare("UPDATE tasks SET status='running',runId=?,attempts=attempts+1 WHERE id=?").run(runId, task.id);
					record(task, runId, "running");
				})();
				try {
					// The host must reject unavailable/failed submission. Stable runId is
					// retained across restart/retry for idempotent submission if supported.
					await config.deliver({ ...task, runId, text: loopPrompt(task) });
					db.transaction(() => {
						record(task, runId, "accepted");
						const current = db.prepare("SELECT status FROM tasks WHERE id=?").get(task.id);
						if (current.status === "cancelled") return;
						if (task.intervalMs) {
							const next = now() + task.intervalMs;
							db.prepare(
								"UPDATE tasks SET status='pending',fireAt=?,nextAttempt=?,runId=NULL,attempts=0 WHERE id=?"
							).run(next, next, task.id);
						} else db.prepare("UPDATE tasks SET status='accepted',runId=NULL WHERE id=?").run(task.id);
					})();
				} catch {
					const failed = task.attempts + 1 >= (config.maxAttempts ?? 10);
					db.transaction(() => {
						db.prepare("UPDATE tasks SET status=?,nextAttempt=? WHERE id=? AND status='running'").run(
							failed ? "failed" : "pending",
							now() + Math.min(3600000, (config.retryBaseMs ?? 30000) * 2 ** task.attempts),
							task.id
						);
						record(task, runId, failed ? "failed" : "retry");
					})();
					console.warn(`[scheduler] submission ${runId} ${failed ? "failed" : "retry persisted"}`);
				}
			}
		}
		return {
			start() {
				if (started) return;
				if (closed) throw new Error("scheduler service is closed");
				worker.acquire();
				// Submission outcome is uncertain on crash. Keep runId; transport decides
				// whether to deduplicate. No session transcript is replayed by this service.
				db.prepare("UPDATE tasks SET status='pending' WHERE status='running'").run();
				started = true;
				arm();
				console.log("[scheduler] durable prompt service started");
			},
			async stop() {
				if (closed) return;
				started = false;
				clearTimeout(timer);
				await active;
				worker.release();
				db.close();
				closed = true;
			},
			schedule(input) {
				const owner = input.owner?.trim();
				const prompt = input.prompt?.trim();
				if (!owner || !prompt) throw new Error("owner and prompt are required");
				if (!Number.isFinite(input.fireAt)) throw new Error("fireAt must be an epoch millisecond timestamp");
				if (input.intervalMs !== undefined && (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0))
					throw new Error("intervalMs must be positive");
				const key = input.idempotencyKey?.trim() || null;
				const task = db.transaction(() => {
					const existing = key ? db.prepare("SELECT * FROM tasks WHERE idempotencyKey=?").get(key) : null;
					if (existing) {
						if (
							existing.owner !== owner ||
							existing.prompt !== prompt ||
							existing.initialFireAt !== input.fireAt ||
							existing.intervalMs !== (input.intervalMs ?? null)
						)
							throw new Error("idempotencyKey already exists with different scheduled data");
						return existing;
					}
					const id = randomUUID();
					db.prepare(
						"INSERT INTO tasks(id,owner,prompt,fireAt,initialFireAt,intervalMs,createdAt,status,idempotencyKey,nextAttempt) VALUES (?,?,?,?,?,?,?,'pending',?,?)"
					).run(id, owner, prompt, input.fireAt, input.fireAt, input.intervalMs ?? null, now(), key, input.fireAt);
					const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
					record(task, id, "pending");
					return task;
				})();
				arm();
				return task;
			},
			list,
			cancel(id, owner) {
				const result = db
					.prepare("UPDATE tasks SET status='cancelled' WHERE id=? AND owner=? AND status IN ('pending','running')")
					.run(id, owner);
				if (!result.changes) return null;
				const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
				record(task, id, "cancelled");
				arm();
				return task;
			},
			history(id) {
				return db.prepare("SELECT id,taskId,status,at FROM history WHERE taskId=? ORDER BY sequence").all(id);
			},
		};
	}
	return {
		parseWhen,
		parseDuration,
		createSchedulerService,
		createBackgroundService,
		validateCompletionFile,
		createReminderService,
		parseReminderTime,
		createCronService,
		parseCronConfig,
	};
}
exports.apiVersion = 1;
exports.formatDuration = formatDuration;
exports.createSessionScheduler = createSessionScheduler;
exports.createServiceBackend = createServiceBackend;
