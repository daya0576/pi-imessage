interface SessionTask {
	id: string;
	prompt: string;
	fireAt: number;
	createdAt: number;
	sessionFile: string | null;
	cwd: string;
	intervalMs?: number;
}
interface SessionContext {
	cwd: string;
	hasUI: boolean;
	isIdle?(): boolean;
	ui: { notify(message: string, type: "info"): void };
}
export function createSessionScheduler<Task extends SessionTask>(config: {
	getActive(): { ctx: SessionContext; sessionFile: string | null } | null;
	getTasks(): Task[];
	setTasks(tasks: Task[]): void;
	storePath(): string;
	updateWidget(): void;
	preview(text: string): string;
	sendUserMessage(prompt: string, options?: { deliverAs: "followUp" }): void;
}): {
	loadStore(): Task[];
	persist(): void;
	disarmAll(): void;
	arm(task: Task): void;
	scheduleTask(spec: string, prompt: string, ctx: SessionContext): Task;
	scheduleLoop(interval: string, prompt: string, ctx: SessionContext): Task;
	cancel(id: string): Task | null;
};
export function formatDuration(milliseconds: number): string;
export const apiVersion: 1;
// Host-supplied dependencies and strongly typed transport APIs are declared by
// each host adapter; runtime implementation is exclusively service.cjs.
export function createServiceBackend(dependencies: { Database: unknown; Cron: unknown }): unknown;
