/**
 * BlueBubbles webhook monitor — receives incoming messages and dispatches to agent.
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AgentManager } from "../agent.js";

/** Incoming webhook payload from BlueBubbles (new-message event). */
export interface BBWebhookPayload {
	type: string;
	data: BBMessage;
}

/** A BlueBubbles message object (subset of fields we care about). */
export interface BBMessage {
	text: string | null;
	isFromMe: boolean;
	chats: Array<{ guid: string }>;
}

export interface MonitorConfig {
	port: number;
	agent: AgentManager;
}

export function createBlueServer(config: MonitorConfig) {
	const { port, agent } = config;

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "POST" && req.url === "/webhook") {
			try {
				const body = await readBody(req);
				const payload: BBWebhookPayload = JSON.parse(body);
				handleWebhook(payload);
				res.writeHead(200);
				res.end("ok");
			} catch (err) {
				console.error("[blue] Webhook error:", err);
				res.writeHead(400);
				res.end("bad request");
			}
			return;
		}

		// Health check
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200);
			res.end("ok");
			return;
		}

		res.writeHead(404);
		res.end("not found");
	});

	function handleWebhook(payload: BBWebhookPayload) {
		if (payload.type !== "new-message") return;

		const msg = payload.data;

		// Skip self-sent messages to avoid loops
		if (msg.isFromMe) return;

		// Skip messages without text
		if (!msg.text?.trim()) return;

		// Get chatGuid
		const chatGuid = msg.chats?.[0]?.guid;
		if (!chatGuid) return;

		console.log(`[blue] ${chatGuid}: ${msg.text.substring(0, 80)}`);

		// Fire and forget — processMessage handles queuing
		agent.processMessage(chatGuid, msg.text).catch((err) => {
			console.error("[blue] processMessage failed:", err);
		});
	}

	return {
		start() {
			server.listen(port, () => {
				console.log(`[blue] Server listening on port ${port}`);
			});
		},
		stop() {
			server.close();
		},
		server,
		/** Exposed for testing */
		handleWebhook,
	};
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}
