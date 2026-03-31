/**
 * Queue primitives.
 *
 * AsyncQueue  — generic unbounded async queue (push/pull/close).
 * KeyedQueue  — keyed serial executor (same key serialized, different keys concurrent).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export class QueueClosedError extends Error {
	constructor() {
		super("Queue closed");
		this.name = "QueueClosedError";
	}
}

export interface AsyncQueue<T> {
	push(item: T): void;
	pull(): Promise<T>;
	close(): void;
}

/**
 * Create an async queue with optional file-based persistence.
 * When `persistPath` is provided, the buffer is restored on creation
 * and flushed to disk after every push/pull.
 */
export function createAsyncQueue<T>(persistPath?: string): AsyncQueue<T> {
	const buffer: T[] = [];
	const waiters: Array<{ resolve: (item: T) => void; reject: (err: Error) => void }> = [];
	let closed = false;

	// Restore persisted items on startup
	if (persistPath && existsSync(persistPath)) {
		try {
			const items = JSON.parse(readFileSync(persistPath, "utf-8")) as T[];
			if (Array.isArray(items)) {
				buffer.push(...items);
				console.log(`[queue] restored ${items.length} item(s) from ${persistPath}`);
			}
		} catch (error) {
			console.error(`[queue] failed to restore from ${persistPath}:`, error);
		}
	}

	function flush(): void {
		if (!persistPath) return;
		try {
			writeFileSync(persistPath, JSON.stringify(buffer));
		} catch (error) {
			console.error(`[queue] failed to persist to ${persistPath}:`, error);
		}
	}

	return {
		push(item: T): void {
			if (closed) return;
			const waiter = waiters.shift();
			if (waiter) {
				waiter.resolve(item);
				// Item bypassed buffer, but still flush (buffer unchanged)
			} else {
				buffer.push(item);
				flush();
			}
		},

		pull(): Promise<T> {
			if (closed) return Promise.reject(new QueueClosedError());
			const item = buffer.shift();
			if (item !== undefined) {
				flush();
				return Promise.resolve(item);
			}
			return new Promise<T>((resolve, reject) => waiters.push({ resolve, reject }));
		},

		close(): void {
			closed = true;
			for (const waiter of waiters) {
				waiter.reject(new QueueClosedError());
			}
			waiters.length = 0;
			buffer.length = 0;
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
