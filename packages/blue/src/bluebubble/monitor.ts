/**
 * BlueBubbles webhook monitor — HTTP server that receives raw webhook events.
 *
 * The monitor performs only basic filtering (event type, isFromMe, empty
 * messages) and pushes validated BBRawMessage objects into an async queue.
 * Higher-level assembly (deriving message type, downloading attachments,
 * constructing the unified IncomingMessage) is the consumer's responsibility.
 */

import { type IncomingMessage as HttpIncomingMessage, type ServerResponse, createServer } from "node:http";

/** A file attachment from a BlueBubbles message. */
export interface BBAttachment {
	guid: string;
	/** Original filename (e.g. "image.jpg"). */
	transferName: string;
	mimeType: string | null;
	totalBytes: number;
}

/** Incoming webhook payload from BlueBubbles (new-message event). */
export interface BBWebhookPayload {
	type: string;
	data: BBRawMessage;
}

/** Raw BlueBubbles message object (subset of fields we care about). */
export interface BBRawMessage {
	text: string | null;
	isFromMe: boolean;
	handle: { address: string; service: string } | null;
	chats: Array<{ guid: string; displayName: string }>;
	attachments: BBAttachment[];
}

// ── Async queue ───────────────────────────────────────────────────────────────

/** Thrown by pull() when the queue has been closed. */
export class QueueClosedError extends Error {
	constructor() {
		super("Queue closed");
		this.name = "QueueClosedError";
	}
}

/**
 * Simple unbounded async queue. push() never blocks; pull() returns a
 * promise that resolves when an item is available.
 *
 * close() rejects all pending waiters with QueueClosedError and causes
 * future pull() calls to reject immediately — enabling graceful shutdown
 * of consumer loops.
 */
function createAsyncQueue<T>() {
	const buffer: T[] = [];
	const waiters: Array<{ resolve: (item: T) => void; reject: (err: Error) => void }> = [];
	let closed = false;

	function push(item: T): void {
		if (closed) return;
		const waiter = waiters.shift();
		if (waiter) {
			waiter.resolve(item);
		} else {
			buffer.push(item);
		}
	}

	function pull(): Promise<T> {
		if (closed) return Promise.reject(new QueueClosedError());
		const item = buffer.shift();
		if (item !== undefined) return Promise.resolve(item);
		return new Promise<T>((resolve, reject) => waiters.push({ resolve, reject }));
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

// ── Monitor ───────────────────────────────────────────────────────────────────

export interface MonitorConfig {
	port: number;
}

export function createBBMonitor(config: MonitorConfig) {
	const { port } = config;
	const queue = createAsyncQueue<BBRawMessage>();

	const server = createServer(async (req: HttpIncomingMessage, res: ServerResponse) => {
		if (req.method === "POST" && (req.url === "/webhook" || req.url === "/")) {
			try {
				const payload: BBWebhookPayload = JSON.parse(await readBody(req));
				handleWebhook(payload);
				res.writeHead(200);
				res.end("ok");
			} catch (error) {
				console.error("[blue] Webhook parse error:", error);
				res.writeHead(400);
				res.end("bad request");
			}
			return;
		}

		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200);
			res.end("ok");
			return;
		}

		res.writeHead(404);
		res.end("not found");
	});

	function handleWebhook(payload: BBWebhookPayload): void {
		if (payload.type !== "new-message") return;

		const { data: raw } = payload;

		if (raw.isFromMe) return;

		const hasText = Boolean(raw.text?.trim());
		const attachments = raw.attachments ?? [];
		const hasAttachments = attachments.length > 0;

		if (!hasText && !hasAttachments) return;

		const chatGuid = raw.chats?.[0]?.guid;
		if (!chatGuid) return;

		console.info(`[blue] webhook received: chatGuid=${chatGuid}, hasText=${hasText}, attachments=${attachments.length}`);

		queue.push(raw);
	}

	return {
		start() {
			server.listen(port, () => {
				console.log(`[blue] Listening on port ${port}`);
			});
		},
		stop() {
			queue.close();
			server.close();
		},
		/** Pull the next raw message from the queue. Awaits until one is available. */
		pull: queue.pull,
		/** Exposed for testing — bypasses HTTP, pushes directly into the queue. */
		handleWebhook,
	};
}

function readBody(req: HttpIncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}
