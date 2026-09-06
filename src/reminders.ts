import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

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
}

export interface ReminderServiceConfig {
	workingDir: string;
	deliver: (reminder: Reminder) => Promise<void>;
	now?: () => number;
	retryBaseMs?: number;
	maxAttempts?: number;
}

interface ReminderRow {
	id: string;
	chat_guid: string;
	text: string;
	scheduled_at: number;
	status: ReminderStatus;
	attempts: number;
	created_at: number;
	delivered_at: number | null;
	cancelled_at: number | null;
	last_error: string | null;
	idempotency_key: string | null;
	next_attempt_at: number;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const EXPLICIT_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;

export function parseReminderTime(value: string): number {
	if (!EXPLICIT_TIMEZONE_PATTERN.test(value)) {
		throw new Error("scheduledAt must be ISO 8601 with an explicit timezone, for example 2026-08-08T21:30:00+08:00");
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error("scheduledAt is not a valid ISO 8601 timestamp");
	return timestamp;
}

function iso(timestamp: number | null): string | null {
	return timestamp === null ? null : new Date(timestamp).toISOString();
}

function mapRow(row: ReminderRow): Reminder {
	return {
		id: row.id,
		chatGuid: row.chat_guid,
		text: row.text,
		scheduledAt: new Date(row.scheduled_at).toISOString(),
		status: row.status,
		attempts: row.attempts,
		createdAt: new Date(row.created_at).toISOString(),
		deliveredAt: iso(row.delivered_at),
		cancelledAt: iso(row.cancelled_at),
		lastError: row.last_error,
		idempotencyKey: row.idempotency_key,
	};
}

export function createReminderService(config: ReminderServiceConfig): ReminderService {
	const now = config.now ?? Date.now;
	const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
	const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	mkdirSync(config.workingDir, { recursive: true });
	const db = new Database(join(config.workingDir, "reminders.db"));
	db.pragma("journal_mode = WAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS reminders (
			id TEXT PRIMARY KEY,
			chat_guid TEXT NOT NULL,
			text TEXT NOT NULL,
			scheduled_at INTEGER NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'cancelled', 'failed')),
			attempts INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			delivered_at INTEGER,
			cancelled_at INTEGER,
			last_error TEXT,
			idempotency_key TEXT UNIQUE,
			next_attempt_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(status, next_attempt_at);
	`);

	const findById = db.prepare("SELECT * FROM reminders WHERE id = ?");
	const findByIdempotencyKey = db.prepare("SELECT * FROM reminders WHERE idempotency_key = ?");
	const insert = db.prepare(`
		INSERT INTO reminders (
			id, chat_guid, text, scheduled_at, status, attempts, created_at,
			delivered_at, cancelled_at, last_error, idempotency_key, next_attempt_at
		) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
	`);
	const listAll = db.prepare("SELECT * FROM reminders ORDER BY scheduled_at ASC, created_at ASC");
	const listByStatus = db.prepare("SELECT * FROM reminders WHERE status = ? ORDER BY scheduled_at ASC, created_at ASC");
	const nextPending = db.prepare(
		"SELECT * FROM reminders WHERE status = 'pending' ORDER BY next_attempt_at ASC, created_at ASC LIMIT 1"
	);
	const duePending = db.prepare(
		"SELECT * FROM reminders WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, created_at ASC"
	);
	const incrementAttempt = db.prepare(
		"UPDATE reminders SET attempts = attempts + 1, last_error = NULL WHERE id = ? AND status = 'pending'"
	);
	const markDelivered = db.prepare(
		"UPDATE reminders SET status = 'delivered', delivered_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'"
	);
	const markRetry = db.prepare(
		"UPDATE reminders SET next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'pending'"
	);
	const markFailed = db.prepare(
		"UPDATE reminders SET status = 'failed', last_error = ? WHERE id = ? AND status = 'pending'"
	);
	const markCancelled = db.prepare(
		"UPDATE reminders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'"
	);

	let timer: ReturnType<typeof setTimeout> | null = null;
	let started = false;
	let processing = false;
	let activeRun: Promise<void> | null = null;
	let closed = false;

	function rowById(id: string): ReminderRow | undefined {
		return findById.get(id) as ReminderRow | undefined;
	}

	function clearTimer(): void {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	function schedule(): void {
		if (!started || processing) return;
		clearTimer();
		const next = nextPending.get() as ReminderRow | undefined;
		if (!next) return;
		const delay = Math.min(Math.max(0, next.next_attempt_at - now()), MAX_TIMER_DELAY_MS);
		timer = setTimeout(() => {
			timer = null;
			activeRun = processDue()
				.catch((error) => console.error("[reminder] scheduler error:", error))
				.finally(() => {
					activeRun = null;
				});
		}, delay);
		timer.unref();
	}

	async function processDue(): Promise<void> {
		if (!started || processing) return;
		processing = true;
		try {
			const rows = duePending.all(now()) as ReminderRow[];
			for (const row of rows) {
				if (!started) break;
				incrementAttempt.run(row.id);
				const current = rowById(row.id);
				if (!current || current.status !== "pending") continue;
				const reminder = mapRow(current);
				try {
					await config.deliver(reminder);
					markDelivered.run(now(), row.id);
					console.log(`[reminder] delivered ${row.id} to ${row.chat_guid}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (current.attempts >= maxAttempts) {
						markFailed.run(message, row.id);
						console.error(`[reminder] permanently failed ${row.id} after ${current.attempts} attempts: ${message}`);
					} else {
						const retryDelay = Math.min(retryBaseMs * 2 ** Math.max(0, current.attempts - 1), 60 * 60 * 1000);
						markRetry.run(now() + retryDelay, message, row.id);
						console.warn(`[reminder] delivery failed ${row.id}; retrying in ${retryDelay}ms: ${message}`);
					}
				}
			}
		} finally {
			processing = false;
			schedule();
		}
	}

	return {
		start(): void {
			if (started) return;
			if (closed) throw new Error("reminder service is closed");
			started = true;
			console.log(`[reminder] scheduler started (${join(config.workingDir, "reminders.db")})`);
			schedule();
		},
		async stop(): Promise<void> {
			if (closed) return;
			started = false;
			clearTimer();
			await activeRun;
			db.close();
			closed = true;
		},
		create(input: CreateReminderInput): CreateReminderResult {
			const chatGuid = input.chatGuid.trim();
			const text = input.text.trim();
			const idempotencyKey = input.idempotencyKey?.trim() || null;
			if (!chatGuid) throw new Error("chatGuid is required");
			if (!text) throw new Error("text is required");
			const scheduledAt = parseReminderTime(input.scheduledAt);

			if (idempotencyKey) {
				const existing = findByIdempotencyKey.get(idempotencyKey) as ReminderRow | undefined;
				if (existing) {
					if (existing.chat_guid !== chatGuid || existing.text !== text || existing.scheduled_at !== scheduledAt) {
						throw new Error("idempotencyKey already exists with different reminder data");
					}
					return { reminder: mapRow(existing), created: false };
				}
			}

			const id = randomUUID();
			const createdAt = now();
			insert.run(id, chatGuid, text, scheduledAt, createdAt, idempotencyKey, scheduledAt);
			const reminder = mapRow(rowById(id) as ReminderRow);
			console.log(`[reminder] scheduled ${id} for ${reminder.scheduledAt} to ${chatGuid}`);
			schedule();
			return { reminder, created: true };
		},
		list(status?: ReminderStatus): Reminder[] {
			const rows = status ? (listByStatus.all(status) as ReminderRow[]) : (listAll.all() as ReminderRow[]);
			return rows.map(mapRow);
		},
		cancel(id: string): Reminder | null {
			const result = markCancelled.run(now(), id);
			if (result.changes === 0) return null;
			const reminder = mapRow(rowById(id) as ReminderRow);
			console.log(`[reminder] cancelled ${id}`);
			schedule();
			return reminder;
		},
	};
}
