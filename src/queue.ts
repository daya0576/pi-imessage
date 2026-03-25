/**
 * Queue primitives.
 *
 * AsyncQueue  — generic unbounded async queue (push/pull/close).
 * KeyedQueue  — keyed serial executor (same key serialized, different keys concurrent).
 */

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

export function createAsyncQueue<T>(): AsyncQueue<T> {
	const buffer: T[] = [];
	const waiters: Array<{ resolve: (item: T) => void; reject: (err: Error) => void }> = [];
	let closed = false;

	return {
		push(item: T): void {
			if (closed) return;
			const waiter = waiters.shift();
			if (waiter) {
				waiter.resolve(item);
			} else {
				buffer.push(item);
			}
		},

		pull(): Promise<T> {
			if (closed) return Promise.reject(new QueueClosedError());
			const item = buffer.shift();
			if (item !== undefined) return Promise.resolve(item);
			return new Promise<T>((resolve, reject) => waiters.push({ resolve, reject }));
		},

		close(): void {
			closed = true;
			for (const waiter of waiters) {
				waiter.reject(new QueueClosedError());
			}
			waiters.length = 0;
			buffer.length = 0;
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
