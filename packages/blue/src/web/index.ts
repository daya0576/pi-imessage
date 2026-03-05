/** Web server: serves the chat log UI and SSE updates. */

import { existsSync, watch } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { getChatBlocks } from "./data.js";
import { renderPage } from "./render.js";

export interface WebServerConfig {
	workingDir: string;
	port: number;
}

export interface WebServer {
	start(): void;
	stop(): void;
}

export function createWebServer(config: WebServerConfig): WebServer {
	const { workingDir, port } = config;
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

		const blocks = getChatBlocks(workingDir);
		const html = renderPage(blocks);
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
	}

	const server = createServer(handleRequest);

	return {
		start(): void {
			startWatcher();
			server.listen(port, () => {
				console.log(`[web] UI available at http://localhost:${port}`);
			});
		},
		stop(): void {
			if (debounceTimer) clearTimeout(debounceTimer);
			watcher?.close();
			server.close();
			for (const client of sseClients) client.end();
			sseClients.clear();
		},
	};
}
