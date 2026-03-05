/**
 * WebServer — minimal ASCII-style web UI for browsing iMessage chat logs.
 *
 * Single flat page: all chats from the last 7 days laid out top-to-bottom,
 * sorted by most-recent message. A fixed sidebar provides #anchor links.
 * Real-time updates via Server-Sent Events (SSE).
 */

import { existsSync, readFileSync, readdirSync, watch } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import type { LoggedMessage } from "./store.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WebServerConfig {
	workingDir: string;
	port: number;
}

export interface WebServer {
	start(): void;
	stop(): void;
}

interface ChatBlock {
	guid: string;
	displayName: string;
	messages: LoggedMessage[];
	lastTime: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function escHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function readMessages(workingDir: string, chatGuid: string): LoggedMessage[] {
	const logFile = join(workingDir, chatGuid, "log.jsonl");
	if (!existsSync(logFile)) return [];
	const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
	const messages: LoggedMessage[] = [];
	for (const line of lines) {
		try {
			messages.push(JSON.parse(line) as LoggedMessage);
		} catch {
			// skip malformed lines
		}
	}
	return messages;
}

function getChatBlocks(workingDir: string): ChatBlock[] {
	if (!existsSync(workingDir)) return [];
	const cutoff = Date.now() - SEVEN_DAYS_MS;
	const blocks: ChatBlock[] = [];

	let entries: string[];
	try {
		entries = readdirSync(workingDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}

	for (const guid of entries) {
		const messages = readMessages(workingDir, guid);
		if (messages.length === 0) continue;
		const lastMessage = messages[messages.length - 1];
		if (!lastMessage) continue;
		const lastTime = new Date(lastMessage.date).getTime();
		if (lastTime < cutoff) continue;

		const parts = guid.split(";");
		let displayName = parts[parts.length - 1] ?? guid;
		if (lastMessage.messageType === "group" && lastMessage.groupName) {
			displayName = lastMessage.groupName;
		}

		blocks.push({ guid, displayName, messages, lastTime });
	}

	blocks.sort((a, b) => b.lastTime - a.lastTime);
	return blocks;
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${month}-${day} ${hour}:${minute}`;
}

function anchorId(guid: string): string {
	return guid.replace(/[^a-zA-Z0-9]/g, "_");
}

function renderPage(workingDir: string): string {
	const blocks = getChatBlocks(workingDir);

	const navLinks = blocks
		.map((block) => `<a href="#${anchorId(block.guid)}">${escHtml(block.displayName)}</a>`)
		.join("\n");

	const chatSections = blocks
		.map((block) => {
			const anchor = anchorId(block.guid);
			const separator = `═══ ${escHtml(block.displayName)} (${block.messages.length} msgs) ═══`;
			const messageLines = block.messages
				.map((msg) => {
					const time = formatTime(msg.date);
					const sender = msg.isBot ? "bot" : msg.sender;
					const text = msg.text ?? "[attachment]";
					const prefix = msg.isBot ? "🤖" : "  ";
					return `${prefix} ${time}  ${escHtml(sender)}&gt; ${escHtml(text)}`;
				})
				.join("\n");
			return `<div id="${anchor}">\n<b>${separator}</b>\n<span style="color:#555">${escHtml(block.guid)}</span>\n\n${messageLines}\n</div>`;
		})
		.join("\n\n");

	return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>pi-mom</title>
<style>
body{background:#111;color:#ccc;font:13px/1.6 "Courier New",monospace;margin:0;padding:16px 200px 16px 16px}
pre{margin:0;white-space:pre-wrap;word-break:break-word}
nav{position:fixed;top:0;right:0;width:180px;height:100vh;overflow-y:auto;padding:12px;background:#0a0a0a;border-left:1px solid #333;font-size:11px}
nav a{display:block;color:#0a8;text-decoration:none;padding:3px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav a:hover{color:#0f8}
b{color:#e8e8e8}
</style></head><body>
<nav>${navLinks}</nav>
<pre>
${chatSections || "── no chats in the last 7 days ──"}
</pre>
<script>
const es=new EventSource("/events");
es.addEventListener("update",()=>location.reload());
</script>
</body></html>`;
}

// ── Server ────────────────────────────────────────────────────────────────────

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
			watcher.on("error", () => {
				// silently ignore watcher errors
			});
		} catch {
			// workingDir may not exist yet
		}
	}

	function handleRequest(request: IncomingMessage, response: ServerResponse): void {
		const url = new URL(request.url ?? "/", `http://localhost:${port}`);
		const requestPath = url.pathname;

		if (requestPath === "/events") {
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

		const html = renderPage(workingDir);
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
