/**
 * BlueBubbles webhook monitor — HTTP server that receives incoming messages.
 */

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

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
	/** Called for each valid inbound message. */
	onMessage: (chatGuid: string, text: string) => void;
}

export function createBBMonitor(config: MonitorConfig) {
	const { port, onMessage } = config;

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

		const { data: message } = payload;

		// BlueBubbles sets isFromMe=true for messages sent by this device (including
		// bot replies). This is the single gate that prevents reply loops.
		if (message.isFromMe) return;
		if (!message.text?.trim()) return;

    console.debug(`[blue] webhook body: ${JSON.stringify(payload)}`);

		const chatGuid = message.chats?.[0]?.guid;
		if (!chatGuid) return;

		onMessage(chatGuid, message.text);
	}

	return {
		start() {
			server.listen(port, () => {
				console.log(`[blue] Listening on port ${port}`);
			});
		},
		stop() {
			server.close();
		},
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
