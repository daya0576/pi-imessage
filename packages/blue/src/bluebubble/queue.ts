/**
 * Async queue for BBRawMessage — shared between the webhook monitor (producer)
 * and the iMessage bot consumer loop (consumer).
 *
 * Keeping the queue in its own file decouples monitor.ts (HTTP + filtering)
 * from imessage.ts (assembly + pipeline). Both depend on this module; neither
 * depends on the other.
 */

import type { BBRawMessage } from "./monitor.js";

// ── QueueClosedError ──────────────────────────────────────────────────────────

/** Thrown by pull() when the queue has been closed. */
export class QueueClosedError extends Error {
	constructor() {
		super("Queue closed");
		this.name = "QueueClosedError";
	}
}

// ── AsyncQueue ────────────────────────────────────────────────────────────────

/**
 * Simple unbounded async queue. push() never blocks; pull() returns a
 * promise that resolves when an item is available.
 *
 * close() rejects all pending waiters with QueueClosedError and causes
 * future pull() calls to reject immediately — enabling graceful shutdown
 * of consumer loops.
 */
export function createRawMessageQueue() {
	const buffer: BBRawMessage[] = [];
	const waiters: Array<{ resolve: (item: BBRawMessage) => void; reject: (err: Error) => void }> = [];
	let closed = false;

	function push(item: BBRawMessage): void {
		if (closed) return;
		const waiter = waiters.shift();
		if (waiter) {
			waiter.resolve(item);
		} else {
			buffer.push(item);
		}
	}

	function pull(): Promise<BBRawMessage> {
		if (closed) return Promise.reject(new QueueClosedError());
		const item = buffer.shift();
		if (item !== undefined) return Promise.resolve(item);
		return new Promise<BBRawMessage>((resolve, reject) => waiters.push({ resolve, reject }));
	}

	function close(): void {
		closed = true;
		for (const waiter of waiters) {
			waiter.reject(new QueueClosedError());
		}
		waiters.length = 0;
		buffer.length = 0;
	}

	return { push, pull, close };
}

export type RawMessageQueue = ReturnType<typeof createRawMessageQueue>;
