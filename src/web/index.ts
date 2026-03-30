/** Web server: serves the chat log UI, logs page, and API endpoints. */

import { existsSync, readFileSync, watch } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import type { AgentManager } from "../agent.js";
import type { SelfEchoFilter } from "../self-echo.js";
import type { MessageSender } from "../send.js";
import type { Settings } from "../settings.js";
import type { AgentReply } from "../types.js";
import { formatAgentReply } from "../types.js";
import { getChatBlocks } from "./data.js";
import { renderLogsPage, renderPage } from "./render.js";

export interface WebServerConfig {
	workingDir: string;
	host: string;
	port: number;
	getSettings: () => Settings;
	setSettings: (settings: Settings) => void;
	sender: MessageSender;
	echoFilter: SelfEchoFilter;
	agent: AgentManager;
}

export interface WebServer {
	start(): void;
	stop(): Promise<void>;
}

/** Read the tail of a log file. */
function readLogTail(path: string, maxLines: number): string {
	if (!existsSync(path)) return "";
	try {
		const content = readFileSync(path, "utf-8");
		const lines = content.split("\n");
		return lines.slice(-maxLines).join("\n");
	} catch {
		return "";
	}
}

/** Parse JSON body from request. */
function parseJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}

export function createWebServer(config: WebServerConfig): WebServer {
	const { workingDir, host, port, getSettings, setSettings, sender, echoFilter, agent } = config;
	const sseClients = new Set<ServerResponse>();
	let fsWatcher: ReturnType<typeof watch> | null = null;
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
			fsWatcher = watch(workingDir, { recursive: true }, (_event, filename) => {
				if (filename?.endsWith("log.jsonl")) broadcast();
			});
			fsWatcher.on("error", () => {});
		} catch {
			// workingDir may not exist yet
		}
	}

	/** Toggle reply for a chatGuid by updating whitelist/blacklist. */
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

	function jsonResponse(response: ServerResponse, status: number, data: unknown): void {
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(JSON.stringify(data));
	}

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", `http://localhost:${port}`);

		// SSE
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

		// Logs page
		if (url.pathname === "/logs" && request.method === "GET") {
			const appLog = readLogTail(join(workingDir, "app.log"), 200);
			const digestLog = readLogTail(join(workingDir, "digest.log"), 200);
			const html = renderLogsPage(appLog, digestLog);
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(html);
			return;
		}

		// POST /send — send a message directly to a chat
		if (request.method === "POST" && url.pathname === "/send") {
			try {
				const body = await parseJsonBody(request);
				const chatGuid = body.chatGuid as string;
				const text = body.text as string;
				if (!chatGuid || !text) {
					jsonResponse(response, 400, { error: "chatGuid and text required" });
					return;
				}
				echoFilter.remember(chatGuid, text);
				await sender.sendMessage(chatGuid, text);
				console.log(`[web] /send: ${chatGuid} "${text.substring(0, 60)}"`);
				jsonResponse(response, 200, { ok: true });
			} catch (error) {
				console.error("[web] /send error:", error);
				jsonResponse(response, 500, { error: String(error) });
			}
			return;
		}

		// POST /prompt — send a prompt to the agent, reply to the chat
		if (request.method === "POST" && url.pathname === "/prompt") {
			try {
				const body = await parseJsonBody(request);
				const chatGuid = body.chatGuid as string;
				const prompt = body.prompt as string;
				if (!chatGuid || !prompt) {
					jsonResponse(response, 400, { error: "chatGuid and prompt required" });
					return;
				}
				console.log(`[web] /prompt: ${chatGuid} "${prompt.substring(0, 60)}"`);
				const replies: string[] = [];
				await agent.processMessage(
					{
						chatGuid,
						sender: "cron",
						text: prompt,
						messageType: "imessage",
						groupName: "",
						replyToText: null,
						attachments: [],
						images: [],
					},
					async (agentReply: AgentReply) => {
						const text = formatAgentReply(agentReply);
						echoFilter.remember(chatGuid, text);
						await sender.sendMessage(chatGuid, text);
						replies.push(text);
					}
				);
				jsonResponse(response, 200, { ok: true, replies });
			} catch (error) {
				console.error("[web] /prompt error:", error);
				jsonResponse(response, 500, { error: String(error) });
			}
			return;
		}

		// POST /toggle
		if (request.method === "POST" && url.pathname === "/toggle") {
			try {
				const body = await parseJsonBody(request);
				toggleChatReply(body.chatGuid as string, body.enabled as boolean);
				console.log(`[web] toggled reply for ${body.chatGuid}: enabled=${body.enabled}`);
				jsonResponse(response, 200, { ok: true });
			} catch (error) {
				console.error("[web] toggle error:", error);
				response.writeHead(400);
				response.end("bad request");
			}
			return;
		}

		// Default: chat page
		const blocks = getChatBlocks(workingDir);
		const settings = getSettings();
		const html = renderPage(blocks, settings);
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
	}

	const server = createServer((req, res) => {
		handleRequest(req, res).catch((error) => {
			console.error("[web] unhandled request error:", error);
			if (!res.headersSent) {
				res.writeHead(500);
				res.end("internal error");
			}
		});
	});

	return {
		start(): void {
			startWatcher();
			server.listen(port, host, () => {
				console.log(`[web] UI available at http://${host}:${port}`);
			});
		},
		stop(): Promise<void> {
			if (debounceTimer) clearTimeout(debounceTimer);
			fsWatcher?.close();
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
