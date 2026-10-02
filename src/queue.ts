/**
 * Queue primitives.
 *
 * AsyncQueue  — generic unbounded async queue (push/pull/close).
 * KeyedQueue  — keyed serial executor (same key serialized, different keys concurrent).
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

export class QueueClosedError extends Error {
	constructor() {
		super("Queue closed");
		this.name = "QueueClosedError";
	}
}

export interface AsyncQueue<T> {
	push(item: T): void;
	/** Atomically persist acceptance and its idempotency key before waking a consumer. */
	pushDurable(item: T, key: string): boolean;
	pull(): Promise<T>;
	/** Mark a pulled item as durably handled so it is no longer replayed after a restart. */
	ack(item: T): void;
	close(): void;
}

/**
 * Create an async queue with optional file-based persistence.
 *
 * When `persistPath` is provided, both the not-yet-delivered `pending` buffer and
 * the delivered-but-not-yet-acked `inflight` set are flushed to disk. On startup,
 * any leftover in-flight items (their processing was interrupted by a crash or
 * restart) are moved back to the front of `pending` for automatic replay.
 *
 * File format: `{ pending: T[], inflight: T[] }`. A legacy top-level array is
 * still accepted and treated as `pending`.
 */
export function createAsyncQueue<T>(persistPath?: string): AsyncQueue<T> {
	const buffer: T[] = [];
	// Delivered to a consumer via pull() but not yet ack()'d. Persisted so an
	// interrupted request is replayed rather than lost.
	const inflight: T[] = [];
	const waiters: Array<{ resolve: (item: T) => void; reject: (err: Error) => void }> = [];
	let closed = false;
	// A sender re-submits only its latest uncertain key after a crash; keep a bounded recent window.
	const acceptedKeys = new Set<string>();
	const MAX_ACCEPTED_KEYS = 1000;

	// Restore persisted items on startup; replay any interrupted in-flight items first.
	if (persistPath && existsSync(persistPath)) {
		try {
			const raw = JSON.parse(readFileSync(persistPath, "utf-8")) as
				| T[]
				| { pending?: T[]; inflight?: T[]; acceptedKeys?: string[] };
			if (!Array.isArray(raw) && Array.isArray(raw.acceptedKeys)) {
				for (const key of raw.acceptedKeys) if (typeof key === "string") acceptedKeys.add(key);
			}
			const restoredPending = Array.isArray(raw) ? raw : Array.isArray(raw.pending) ? raw.pending : [];
			const restoredInflight = Array.isArray(raw) ? [] : Array.isArray(raw.inflight) ? raw.inflight : [];
			// Interrupted in-flight items replay ahead of pending input, preserving arrival order.
			buffer.push(...restoredInflight, ...restoredPending);
			if (restoredInflight.length > 0)
				console.log(`[queue] replaying ${restoredInflight.length} interrupted in-flight item(s) from ${persistPath}`);
			if (buffer.length > 0) console.log(`[queue] restored ${buffer.length} item(s) from ${persistPath}`);
		} catch (error) {
			console.error(`[queue] failed to restore from ${persistPath}:`, error);
		}
	}

	function persist(pending: T[], active: T[], keys = [...acceptedKeys]): void {
		if (!persistPath) throw new Error("Durable queue submission requires a persistence path");
		const temporary = `${persistPath}.${randomUUID()}.tmp`;
		try {
			const descriptor = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(descriptor, JSON.stringify({ pending, inflight: active, acceptedKeys: keys }));
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			renameSync(temporary, persistPath);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}

	function flush(): void {
		if (!persistPath) return;
		try {
			persist(buffer, inflight);
		} catch (error) {
			console.error(`[queue] failed to persist to ${persistPath}:`, error);
		}
	}

	return {
		push(item: T): void {
			if (closed) return;
			const waiter = waiters.shift();
			if (waiter) {
				// Handed straight to a consumer: it is now in-flight until ack'd.
				inflight.push(item);
				flush();
				waiter.resolve(item);
			} else {
				buffer.push(item);
				flush();
			}
		},

		pushDurable(item: T, key: string): boolean {
			if (closed) throw new QueueClosedError();
			if (!key) throw new Error("Durable queue submission requires an idempotency key");
			if (acceptedKeys.has(key)) return false;
			const waiter = waiters[0];
			const keys = [...acceptedKeys, key].slice(-MAX_ACCEPTED_KEYS);
			persist(waiter ? buffer : [...buffer, item], waiter ? [...inflight, item] : inflight, keys);
			acceptedKeys.clear();
			for (const accepted of keys) acceptedKeys.add(accepted);
			if (waiter) {
				waiters.shift();
				inflight.push(item);
				waiter.resolve(item);
			} else buffer.push(item);
			return true;
		},

		pull(): Promise<T> {
			if (closed) return Promise.reject(new QueueClosedError());
			const item = buffer.shift();
			if (item !== undefined) {
				inflight.push(item);
				flush();
				return Promise.resolve(item);
			}
			return new Promise<T>((resolve, reject) => waiters.push({ resolve, reject }));
		},

		ack(item: T): void {
			const index = inflight.indexOf(item);
			if (index === -1) return;
			inflight.splice(index, 1);
			flush();
		},

		close(): void {
			closed = true;
			for (const waiter of waiters) {
				waiter.reject(new QueueClosedError());
			}
			waiters.length = 0;
			// Do NOT drop pending/inflight: persist them so a restart resumes the work.
			flush();
		},
	};
}

// ── KeyedQueue ────────────────────────────────────────────────────────────────

/** Same key → serial. Different keys → concurrent. */
export function createKeyedQueue(): (key: string, task: () => Promise<void>) => void {
	const chains = new Map<string, Promise<void>>();
	return (key, task) => {
		chains.set(key, (chains.get(key) ?? Promise.resolve()).then(task, task));
	};
}
