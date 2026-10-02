import { schedulerBackend } from "./shared-scheduler.js";

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
	deliver: (chatGuid: string, text: string, idempotencyKey?: string) => Promise<void>;
	now?: () => number;
}
export interface BackgroundService {
	create(input: BackgroundInput): BackgroundJob;
	list(): BackgroundJob[];
	history(id: string): { jobId: string; state: string; at: number }[];
	start(): void;
	stop(): Promise<void>;
	tick(): Promise<void>;
}
/** Implementation is owned by the installed Pi scheduler extension, not a chat session. */
export function createBackgroundService(config: BackgroundConfig): BackgroundService {
	return schedulerBackend().createBackgroundService(config);
}
/** Rechecked by the shared backend at registration and every marker read. */
export function validateCompletionFile(root: string, chatGuid: string, file: string): string {
	return schedulerBackend().validateCompletionFile(root, chatGuid, file);
}
