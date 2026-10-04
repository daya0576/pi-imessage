import { schedulerBackend } from "./backend.ts";

export interface ScheduledPrompt {
	id: string;
	owner: string;
	prompt: string;
	fireAt: number;
	intervalMs: number | null;
	createdAt: number;
	status: "pending" | "running" | "accepted" | "cancelled" | "failed";
	idempotencyKey: string | null;
	attempts: number;
	runId: string | null;
	nextAttempt: number;
}
export interface SchedulePromptInput {
	owner: string;
	prompt: string;
	fireAt: number;
	intervalMs?: number;
	idempotencyKey?: string;
}
export interface SchedulerServiceConfig {
	workingDir: string;
	/** Submit to a service-owned chat queue/session; resolve only after acceptance. */
	deliver: (task: ScheduledPrompt & { runId: string; text?: string }) => Promise<void>;
	now?: () => number;
	retryBaseMs?: number;
	maxAttempts?: number;
}
export interface SchedulerService {
	start(): void;
	stop(): Promise<void>;
	schedule(input: SchedulePromptInput): ScheduledPrompt;
	list(owner?: string): ScheduledPrompt[];
	cancel(id: string, owner: string): ScheduledPrompt | null;
	history(id: string): { id: string; taskId: string; status: string; at: number }[];
}
/** Independent of SDK session disposal. Only the active service lifecycle starts timers. */
export function createSchedulerService(config: SchedulerServiceConfig): SchedulerService {
	return schedulerBackend().createSchedulerService(config);
}
export function parseSchedulerTime(when: string, now = Date.now()): number {
	return schedulerBackend().parseWhen(when, now);
}
export function parseSchedulerInterval(interval: string): number | null {
	return schedulerBackend().parseDuration(interval);
}
