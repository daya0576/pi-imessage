/** Web server: serves the chat log UI and SSE updates. */

import { existsSync, watch } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { ChatAllowlist, Settings } from "../settings.js";
import { getChatBlocks } from "./data.js";
import { renderPage } from "./render.js";

export interface WebServerConfig {
	workingDir: string;
	host: string;
	port: number;
	getSettings: () => Settings;
	setSettings: (settings: Settings) => void;
}

export interface WebServer {
	start(): void;
	stop(): Promise<void>;
}

export function createWebServer(config: WebServerConfig): WebServer {
	const { workingDir, host, port, getSettings, setSettings } = config;
	const sseClients = new Set<ServerResponse>();
	let watcher: ReturnType<typeof watch> | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function broadcast(): void {
		if (debounceTimer) return;
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			for (const client of sseClients) {
				client.write("event: update\ndata: {}\n\n");
			}
		}, 300);
	}

	function startWatcher(): void {
		if (!existsSync(workingDir)) return;
		try {
			watcher = watch(workingDir, { recursive: true }, (_event, filename) => {
				if (filename?.endsWith("log.jsonl")) broadcast();
			});
			watcher.on("error", () => {});
		} catch {
			// workingDir may not exist yet
		}
	}

	/** Toggle reply for a chatGuid by updating whitelist/blacklist. Does not touch "*" wildcards. */
	function toggleChatReply(chatGuid: string, enabled: boolean): void {
		const { chatAllowlist, ...rest } = getSettings();
		const whitelist = chatAllowlist.whitelist.filter((id) => id !== chatGuid);
		const blacklist = chatAllowlist.blacklist.filter((id) => id !== chatGuid);
		if (enabled) {
			whitelist.push(chatGuid);
		} else {
			blacklist.push(chatGuid);
		}
		setSettings({ ...rest, chatAllowlist: { whitelist, blacklist } });
	}

	function handleRequest(request: IncomingMessage, response: ServerResponse): void {
		const url = new URL(request.url ?? "/", `http://localhost:${port}`);

		if (url.pathname === "/events") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			response.write("retry: 5000\n\n");
			sseClients.add(response);
			request.on("close", () => sseClients.delete(response));
			return;
		}

		if (request.method === "POST" && url.pathname === "/toggle") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => {
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString()) as { chatGuid: string; enabled: boolean };
					toggleChatReply(body.chatGuid, body.enabled);
					console.log(`[web] toggled reply for ${body.chatGuid}: enabled=${body.enabled}`);
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end(JSON.stringify({ ok: true }));
				} catch (error) {
					console.error("[web] toggle error:", error);
					response.writeHead(400);
					response.end("bad request");
				}
			});
			return;
		}

		const blocks = getChatBlocks(workingDir);
		const settings = getSettings();
		const html = renderPage(blocks, settings);
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
	}

	const server = createServer(handleRequest);

	return {
		start(): void {
			startWatcher();
			server.listen(port, host, () => {
				console.log(`[web] UI available at http://${host}:${port}`);
			});
		},
		stop(): Promise<void> {
			if (debounceTimer) clearTimeout(debounceTimer);
			watcher?.close();
			for (const client of sseClients) client.end();
			sseClients.clear();
			return new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						console.error("[web] server close error:", error);
						reject(error);
					} else {
						console.log("[web] server closed");
						resolve();
					}
				});
			});
		},
	};
}
