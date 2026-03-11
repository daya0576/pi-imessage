/**
 * BlueBubbles webhook monitor — HTTP server that receives raw webhook events.
 *
 * The monitor performs only basic filtering (event type, isFromMe, empty
 * messages) and pushes validated BBRawMessage objects into an externally
 * managed queue. Higher-level assembly (deriving message type, downloading
 * attachments, constructing the unified IncomingMessage) is the consumer's
 * responsibility.
 */

import { type IncomingMessage as HttpIncomingMessage, type ServerResponse, createServer } from "node:http";
import type { RawMessageQueue } from "./queue.js";

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

// ── Monitor ───────────────────────────────────────────────────────────────────

export interface MonitorConfig {
	host: string;
	port: number;
	queue: RawMessageQueue;
}

export function createBBMonitor(config: MonitorConfig) {
	const { host, port, queue } = config;

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

		console.info(
			`[blue] webhook received: chatGuid=${chatGuid}, hasText=${hasText}, attachments=${attachments.length}, body=${JSON.stringify(raw)}`
		);

		queue.push(raw);
	}

	return {
		start() {
			server.listen(port, host, () => {
				console.log(`[blue] Listening on ${host}:${port}`);
			});
		},
		stop(): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						console.error("[blue] monitor server close error:", error);
						reject(error);
					} else {
						console.log("[blue] monitor server closed");
						resolve();
					}
				});
			});
		},
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
