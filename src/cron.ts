import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Cron } from "croner";

export type CronAction =
	| { type: "send"; chatGuid: string; text: string }
	| { type: "prompt"; chatGuid: string; prompt: string }
	| { type: "exec"; argv: string[]; cwd?: string };

export interface CronJobConfig {
	id: string;
	name?: string;
	enabled?: boolean;
	schedule: string;
	timezone?: string;
	timeoutSeconds?: number;
	action: CronAction;
}

export interface CronConfigFile {
	version: 1;
	jobs: CronJobConfig[];
}

export type CronRunStatus = "running" | "success" | "failed" | "timeout" | "skipped-overlap";

export interface CronRun {
	id: string;
	jobId: string;
	trigger: "scheduled" | "manual";
	status: CronRunStatus;
	startedAt: string;
	finishedAt: string | null;
	error: string | null;
}

export interface CronJobView extends CronJobConfig {
	enabled: boolean;
	timezone: string;
	nextRunAt: string | null;
	running: boolean;
	lastRun: CronRun | null;
}

export interface CronService {
	start(): void;
	stop(): Promise<void>;
	list(): CronJobView[];
	listRuns(limit?: number): CronRun[];
	reload(): void;
	runNow(id: string): Promise<CronRun>;
	setEnabled(id: string, enabled: boolean): CronJobView;
	configPath: string;
}

export interface CronServiceConfig {
	workingDir: string;
	execute: (job: CronJobConfig, signal: AbortSignal) => Promise<void>;
	defaultTimezone?: string;
	now?: () => Date;
}

interface ScheduledJob {
	config: CronJobConfig;
	cron: Cron;
}

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_RUN_HISTORY = 500;

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function validateAction(value: unknown, jobId: string): CronAction {
	if (!value || typeof value !== "object") throw new Error(`cron job ${jobId}: action must be an object`);
	const action = value as Record<string, unknown>;
	const type = requireString(action.type, `cron job ${jobId}: action.type`);
	if (type === "send") {
		return {
			type,
			chatGuid: requireString(action.chatGuid, `cron job ${jobId}: action.chatGuid`),
			text: requireString(action.text, `cron job ${jobId}: action.text`),
		};
	}
	if (type === "prompt") {
		return {
			type,
			chatGuid: requireString(action.chatGuid, `cron job ${jobId}: action.chatGuid`),
			prompt: requireString(action.prompt, `cron job ${jobId}: action.prompt`),
		};
	}
	if (type === "exec") {
		if (
			!Array.isArray(action.argv) ||
			action.argv.length === 0 ||
			action.argv.some((part) => typeof part !== "string")
		) {
			throw new Error(`cron job ${jobId}: action.argv must be a non-empty string array`);
		}
		const argv = action.argv.map((part) => part.trim());
		if (argv.some((part) => !part)) throw new Error(`cron job ${jobId}: action.argv entries cannot be empty`);
		if (!argv[0]?.startsWith("/")) throw new Error(`cron job ${jobId}: action.argv[0] must be an absolute path`);
		const cwd = action.cwd === undefined ? undefined : requireString(action.cwd, `cron job ${jobId}: action.cwd`);
		return { type, argv, cwd };
	}
	throw new Error(`cron job ${jobId}: unsupported action type ${type}`);
}

export function parseCronConfig(raw: string, defaultTimezone = DEFAULT_TIMEZONE): CronConfigFile {
	const value = JSON.parse(raw) as Record<string, unknown>;
	if (!value || value.version !== 1 || !Array.isArray(value.jobs)) {
		throw new Error("cron config must contain version=1 and a jobs array");
	}
	const ids = new Set<string>();
	const jobs = value.jobs.map((candidate, index): CronJobConfig => {
		if (!candidate || typeof candidate !== "object") throw new Error(`cron job ${index}: must be an object`);
		const input = candidate as Record<string, unknown>;
		const id = requireString(input.id, `cron job ${index}: id`);
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`cron job ${id}: id contains invalid characters`);
		if (ids.has(id)) throw new Error(`duplicate cron job id: ${id}`);
		ids.add(id);
		const schedule = requireString(input.schedule, `cron job ${id}: schedule`);
		const timezone =
			input.timezone === undefined ? defaultTimezone : requireString(input.timezone, `cron job ${id}: timezone`);
		const timeoutSeconds = input.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(input.timeoutSeconds);
		if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
			throw new Error(`cron job ${id}: timeoutSeconds must be positive`);
		}
		const enabled = input.enabled === undefined ? true : input.enabled;
		if (typeof enabled !== "boolean") throw new Error(`cron job ${id}: enabled must be boolean`);
		const name = input.name === undefined ? undefined : requireString(input.name, `cron job ${id}: name`);
		const action = validateAction(input.action, id);

		// Construction validates both the cron expression and IANA timezone.
		const validator = new Cron(schedule, { timezone, paused: true });
		validator.stop();
		return { id, name, enabled, schedule, timezone, timeoutSeconds, action };
	});
	return { version: 1, jobs };
}

function loadRunHistory(path: string): CronRun[] {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter(Boolean)
			.slice(-MAX_RUN_HISTORY)
			.map((line) => JSON.parse(line) as CronRun);
	} catch (error) {
		console.warn(`[cron] could not load run history: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

export function createCronService(config: CronServiceConfig): CronService {
	const cronDir = join(config.workingDir, "cron");
	const configPath = join(cronDir, "jobs.json");
	const runsPath = join(cronDir, "runs.jsonl");
	const defaultTimezone = config.defaultTimezone ?? DEFAULT_TIMEZONE;
	const now = config.now ?? (() => new Date());
	mkdirSync(cronDir, { recursive: true });
	if (!existsSync(configPath)) {
		writeFileSync(configPath, `${JSON.stringify({ version: 1, jobs: [] }, null, 2)}\n`, "utf-8");
	}

	let currentConfig = parseCronConfig(readFileSync(configPath, "utf-8"), defaultTimezone);
	const scheduled = new Map<string, ScheduledJob>();
	let runs = loadRunHistory(runsPath);
	const activeRuns = new Map<string, Promise<CronRun>>();
	let started = false;
	let closed = false;
	let watcher: ReturnType<typeof watch> | null = null;
	let reloadTimer: ReturnType<typeof setTimeout> | null = null;

	function appendRun(run: CronRun): void {
		runs.push(run);
		if (runs.length > MAX_RUN_HISTORY) runs = runs.slice(-MAX_RUN_HISTORY);
		appendFileSync(runsPath, `${JSON.stringify(run)}\n`, "utf-8");
	}

	function lastRun(jobId: string): CronRun | null {
		for (let index = runs.length - 1; index >= 0; index--) {
			if (runs[index]?.jobId === jobId) return runs[index] ?? null;
		}
		return null;
	}

	function stopSchedules(): void {
		for (const item of scheduled.values()) item.cron.stop();
		scheduled.clear();
	}

	function scheduleJobs(): void {
		stopSchedules();
		if (!started) return;
		for (const job of currentConfig.jobs) {
			if (job.enabled === false) continue;
			const cron = new Cron(
				job.schedule,
				{
					name: job.id,
					timezone: job.timezone ?? defaultTimezone,
					protect: () => recordOverlap(job, "scheduled"),
					catch: (error) => console.error(`[cron] uncaught error in ${job.id}:`, error),
					unref: true,
				},
				async () => {
					await beginRun(job, "scheduled");
				}
			);
			scheduled.set(job.id, { config: job, cron });
		}
		console.log(`[cron] loaded ${currentConfig.jobs.length} jobs (${scheduled.size} enabled)`);
	}

	function recordOverlap(job: CronJobConfig, trigger: "scheduled" | "manual"): CronRun {
		const timestamp = now().toISOString();
		const run: CronRun = {
			id: randomUUID(),
			jobId: job.id,
			trigger,
			status: "skipped-overlap",
			startedAt: timestamp,
			finishedAt: timestamp,
			error: "previous run is still active",
		};
		appendRun(run);
		console.warn(`[cron] skipped overlapping run: ${job.id}`);
		return run;
	}

	async function executeJob(job: CronJobConfig, trigger: "scheduled" | "manual"): Promise<CronRun> {
		const controller = new AbortController();
		const timeoutMs = (job.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				const error = new Error(`timed out after ${timeoutMs}ms`);
				controller.abort(error);
				reject(error);
			}, timeoutMs);
			timeout.unref();
		});
		const run: CronRun = {
			id: randomUUID(),
			jobId: job.id,
			trigger,
			status: "running",
			startedAt: now().toISOString(),
			finishedAt: null,
			error: null,
		};
		console.log(`[cron] run start: ${job.id} trigger=${trigger} action=${job.action.type}`);
		try {
			await Promise.race([config.execute(job, controller.signal), timeoutPromise]);
			run.status = "success";
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			run.status = controller.signal.aborted ? "timeout" : "failed";
			run.error = reason;
		} finally {
			if (timeout) clearTimeout(timeout);
			run.finishedAt = now().toISOString();
			appendRun(run);
			console.log(
				`[cron] run end: ${job.id} status=${run.status}${run.error ? ` error=${JSON.stringify(run.error)}` : ""}`
			);
		}
		return run;
	}

	function beginRun(job: CronJobConfig, trigger: "scheduled" | "manual"): Promise<CronRun> {
		if (activeRuns.has(job.id)) return Promise.resolve(recordOverlap(job, trigger));
		const promise = executeJob(job, trigger).finally(() => activeRuns.delete(job.id));
		activeRuns.set(job.id, promise);
		return promise;
	}

	function reload(): void {
		const candidate = parseCronConfig(readFileSync(configPath, "utf-8"), defaultTimezone);
		currentConfig = candidate;
		scheduleJobs();
	}

	function writeConfig(next: CronConfigFile): void {
		const temporary = `${configPath}.tmp-${process.pid}`;
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
		renameSync(temporary, configPath);
	}

	function list(): CronJobView[] {
		return currentConfig.jobs.map((job) => ({
			...job,
			enabled: job.enabled !== false,
			timezone: job.timezone ?? defaultTimezone,
			nextRunAt: scheduled.get(job.id)?.cron.nextRun()?.toISOString() ?? null,
			running: activeRuns.has(job.id),
			lastRun: lastRun(job.id),
		}));
	}

	return {
		configPath,
		start(): void {
			if (started) return;
			if (closed) throw new Error("cron service is closed");
			started = true;
			scheduleJobs();
			watcher = watch(dirname(configPath), (_event, filename) => {
				if (basename(filename?.toString() ?? "") !== basename(configPath)) return;
				if (reloadTimer) clearTimeout(reloadTimer);
				reloadTimer = setTimeout(() => {
					reloadTimer = null;
					try {
						reload();
						console.log(`[cron] reloaded ${configPath}`);
					} catch (error) {
						console.error(
							`[cron] reload rejected; keeping last valid config: ${error instanceof Error ? error.message : String(error)}`
						);
					}
				}, 200);
			});
			watcher.on("error", (error) => console.error("[cron] config watcher error:", error));
		},
		async stop(): Promise<void> {
			if (closed) return;
			started = false;
			stopSchedules();
			watcher?.close();
			watcher = null;
			if (reloadTimer) clearTimeout(reloadTimer);
			await Promise.allSettled(activeRuns.values());
			closed = true;
		},
		list,
		listRuns(limit = 100): CronRun[] {
			return runs.slice(-Math.max(0, limit)).reverse();
		},
		reload,
		runNow(id: string): Promise<CronRun> {
			const job = currentConfig.jobs.find((item) => item.id === id);
			if (!job) throw new Error(`cron job not found: ${id}`);
			return beginRun(job, "manual");
		},
		setEnabled(id: string, enabled: boolean): CronJobView {
			const index = currentConfig.jobs.findIndex((item) => item.id === id);
			if (index < 0) throw new Error(`cron job not found: ${id}`);
			const jobs = currentConfig.jobs.map((job, jobIndex) => (jobIndex === index ? { ...job, enabled } : job));
			const next: CronConfigFile = { version: 1, jobs };
			writeConfig(next);
			currentConfig = next;
			scheduleJobs();
			return list().find((job) => job.id === id) as CronJobView;
		},
	};
}
