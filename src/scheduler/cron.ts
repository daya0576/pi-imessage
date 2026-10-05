import { schedulerBackend } from "./backend.ts";

/** `command` runs an absolute executable; its stdout replaces `text` or `prompt`, and empty output skips the run. */
export type CronAction =
	| { type: "send"; chatGuid: string; text?: string; command?: string[] }
	| { type: "prompt"; chatGuid: string; prompt?: string; command?: string[] }
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
	blocked?: boolean;
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
export function parseCronConfig(raw: string, defaultTimezone?: string): CronConfigFile {
	return schedulerBackend().parseCronConfig(raw, defaultTimezone);
}
export function createCronService(config: CronServiceConfig): CronService {
	return schedulerBackend().createCronService(config);
}
