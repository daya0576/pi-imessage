import { schedulerBackend } from "./shared-scheduler.js";

export const REMINDER_STATUSES = ["pending", "delivered", "cancelled", "failed"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export interface Reminder {
	id: string;
	chatGuid: string;
	text: string;
	scheduledAt: string;
	status: ReminderStatus;
	attempts: number;
	createdAt: string;
	deliveredAt: string | null;
	cancelledAt: string | null;
	lastError: string | null;
	idempotencyKey: string | null;
}
export interface CreateReminderInput {
	chatGuid: string;
	text: string;
	scheduledAt: string;
	idempotencyKey?: string;
}
export interface CreateReminderResult {
	reminder: Reminder;
	created: boolean;
}
export interface ReminderService {
	start(): void;
	stop(): Promise<void>;
	create(input: CreateReminderInput): CreateReminderResult;
	list(status?: ReminderStatus): Reminder[];
	cancel(id: string): Reminder | null;
	history?(id: string): { reminderId: string; status: string; at: number }[];
}
export interface ReminderServiceConfig {
	workingDir: string;
	deliver: (reminder: Reminder) => Promise<void>;
	now?: () => number;
	retryBaseMs?: number;
	maxAttempts?: number;
}
export function parseReminderTime(value: string): number {
	return schedulerBackend().parseReminderTime(value);
}
export function createReminderService(config: ReminderServiceConfig): ReminderService {
	return schedulerBackend().createReminderService(config);
}
