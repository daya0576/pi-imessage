import { randomUUID } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type Cursor,
	type Harness,
	LiveDoc,
	type Submission,
} from "@earendil-works/pi-durable";
import { Chats } from "../agent/chats.ts";
import type { DirectSendInput, DirectSendReceipt } from "../agent/direct-send.ts";
import { DirectSends } from "../agent/direct-send.ts";
import type { PromptInput } from "../agent/isolated.ts";
import { Sessions } from "../agent/isolated.ts";
import { Deliveries } from "../agent/replies.ts";
import { readSettings } from "../config/settings.ts";

export interface WebAgent {
	harness: Harness;
	prompt(input: PromptInput): Promise<Submission>;
	sendDirect(input: DirectSendInput): Promise<DirectSendReceipt>;
	health(): Promise<{ ok: boolean; model: string; latencyMs: number; checkedAt: string }>;
}
export interface ScheduledAPI {
	data(): unknown;
	listReminders(status?: string): unknown;
	createReminder(input: {
		chatGuid: string;
		text: string;
		scheduledAt: string;
		idempotencyKey?: string;
	}): unknown;
	cancelReminder(id: string): unknown;
	runCron(id: string): Promise<unknown>;
	setCronEnabled(id: string, enabled: boolean): unknown;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	let size = 0;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for await (const chunk of request) {
		size += chunk.byteLength;
		if (size > 1024 * 1024) throw new Error("Request exceeds 1 MiB");
		text += decoder.decode(chunk, { stream: true });
	}
	text += decoder.decode();
	const parsed: unknown = JSON.parse(text || "{}");
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Expected a JSON object");
	return parsed as Record<string, unknown>;
}
function readCursor(value: string | null): Cursor | undefined {
	if (!value) return;
	if (value.length > 2048) throw new Error("Invalid cursor");
	const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid cursor");
	return parsed as Cursor;
}
function required(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
	return value;
}
function redact(value: unknown): string {
	return JSON.stringify(
		value,
		(key, item) =>
			/^(authorization|password|apiKey|accessToken|refreshToken|secret)$/i.test(key)
				? "[redacted]"
				: typeof item === "string" && item.length > 50000
					? `${item.slice(0, 50000)}\n[truncated]`
					: item,
		2,
	)
		.replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,})\b/g, "[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}
function json(response: ServerResponse, status: number, value: unknown) {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(redact(value));
}
function escapeHtml(text: string) {
	return text.replace(
		/[&<>"']/g,
		(value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value] ?? value,
	);
}

/** Read-only pages and explicit compatible API actions. Viewing pages never submits model or delivery work. */
export async function startWeb(options: {
	workingDir: string;
	agent: WebAgent;
	scheduled?: ScheduledAPI;
	host?: string;
	port?: number;
	automation?: () => unknown;
}) {
	const streams = new Map<ServerResponse, () => void>();
	const server = createServer((request, response) => {
		void handle(request, response).catch((error) => {
			if (!response.headersSent)
				json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
			else response.end();
		});
	});
	async function handle(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method === "GET" && url.pathname === "/favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (
			request.headers["sec-fetch-site"] === "cross-site" ||
			(request.headers.origin && new URL(request.headers.origin).host !== request.headers.host)
		) {
			json(response, 403, { error: "Cross-origin requests are not allowed" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/send") {
			const input = await body(request);
			const requestId = typeof input.requestId === "string" ? input.requestId : randomUUID();
			const receipt = await options.agent.sendDirect({
				chatGuid: required(input.chatGuid, "chatGuid"),
				requestId,
				text: typeof input.text === "string" ? input.text : undefined,
				filePath:
					typeof input.filePath === "string"
						? input.filePath
						: typeof input.attachmentPath === "string"
							? input.attachmentPath
							: undefined,
			});
			const unknown = receipt.textStatus === "unknown" || receipt.fileStatus === "unknown";
			json(response, unknown ? 503 : 200, { ok: !unknown, requestId, receipt });
			return;
		}
		if (request.method === "POST" && url.pathname === "/prompt") {
			const input = await body(request);
			// Durable has no single-conversation purge API; never silently downgrade ephemeral privacy.
			if (input.ephemeral === true) {
				json(response, 501, { ok: false, error: "Ephemeral storage cleanup is not implemented yet" });
				return;
			}
			const requestId = typeof input.requestId === "string" ? input.requestId : randomUUID();
			const submission = await options.agent.prompt({
				chatGuid: required(input.chatGuid, "chatGuid"),
				prompt: required(input.prompt, "prompt"),
				requestId,
				sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined,
			});
			json(response, 200, { ok: true, requestId, submissionId: submission.id });
			return;
		}
		if (request.method === "GET" && url.pathname === "/health/model") {
			try {
				json(response, 200, await options.agent.health());
			} catch (error) {
				json(response, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		const scheduled = options.scheduled;
		if (url.pathname === "/reminders") {
			if (!scheduled) {
				json(response, 503, { ok: false, error: "Scheduler is not enabled" });
				return;
			}
			if (request.method === "GET") {
				json(response, 200, scheduled.listReminders(url.searchParams.get("status") ?? undefined));
				return;
			}
			if (request.method === "POST") {
				const input = await body(request);
				json(
					response,
					200,
					scheduled.createReminder({
						chatGuid: required(input.chatGuid, "chatGuid"),
						text: required(input.text, "text"),
						scheduledAt: required(input.scheduledAt, "scheduledAt"),
						idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
					}),
				);
				return;
			}
		}
		if (request.method === "DELETE" && url.pathname.startsWith("/reminders/") && scheduled) {
			json(response, 200, scheduled.cancelReminder(decodeURIComponent(url.pathname.slice(11))));
			return;
		}
		if (request.method === "GET" && url.pathname === "/scheduled/data") {
			json(response, scheduled ? 200 : 503, scheduled?.data() ?? { error: "Scheduler is not enabled" });
			return;
		}
		const cron = url.pathname.match(/^\/cron\/jobs\/([^/]+)\/(run|enabled)$/);
		if (request.method === "POST" && cron && scheduled) {
			const id = decodeURIComponent(cron[1]);
			if (cron[2] === "run") json(response, 200, await scheduled.runCron(id));
			else {
				const input = await body(request);
				if (typeof input.enabled !== "boolean") throw new Error("enabled must be boolean");
				json(response, 200, scheduled.setCronEnabled(id, input.enabled));
			}
			return;
		}
		if (request.method !== "GET") {
			json(response, 404, { error: "Not found" });
			return;
		}
		if (url.pathname === "/events") {
			response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
			response.write('data: {"updated":true}\n\n');
			const unsubscribe = options.agent.harness.subscribeCommits(() => {
				if (!response.write('data: {"updated":true}\n\n')) {
					unsubscribe();
					response.destroy();
				}
			});
			streams.set(response, unsubscribe);
			response.on("error", () => {
				unsubscribe();
				streams.delete(response);
			});
			response.on("close", () => {
				unsubscribe();
				streams.delete(response);
			});
			return;
		}
		let value: unknown;
		let nextCursor: Cursor | undefined;
		const page = url.pathname.replace(/\/data$/, "");
		if (page === "/" || page === "/chat") {
			const id = url.searchParams.get("conversationId");
			if (id) {
				if (!/^\d+$/.test(id)) throw new Error("Invalid conversation ID");
				const conversation = await options.agent.harness.conversation(
					Number(id) as ConversationId,
					BACKGROUND_CONTEXT,
				);
				if (!conversation) {
					json(response, 404, { error: "Conversation not found" });
					return;
				}
				const history = await conversation.entries(
					{},
					100,
					readCursor(url.searchParams.get("cursor")),
					BACKGROUND_CONTEXT,
				);
				nextCursor = history.next;
				value = {
					history,
					agent: await conversation.agent(BACKGROUND_CONTEXT),
					delivery: await options.agent.harness.snapshot(Deliveries, conversation.id, BACKGROUND_CONTEXT),
					live: await options.agent.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT),
				};
			} else
				value = {
					chats: await options.agent.harness.snapshot(Chats, BACKGROUND_CONTEXT),
					sessions: await options.agent.harness.snapshot(Sessions, BACKGROUND_CONTEXT),
					tasks: await options.agent.harness.commit((tx) => tx.scanTasks({}, 100), BACKGROUND_CONTEXT),
					inspection: await options.agent.harness.inspect(BACKGROUND_CONTEXT),
					sends: await options.agent.harness.snapshot(DirectSends, BACKGROUND_CONTEXT),
				};
		} else if (page === "/settings") value = await readSettings(options.workingDir);
		else if (page === "/scheduled") value = scheduled?.data() ?? { error: "Scheduler is not enabled" };
		else if (page === "/automation") value = options.automation?.() ?? { tasks: [] };
		else if (page === "/logs") {
			const tasks = await options.agent.harness.commit(
				(tx) => tx.scanTasks({}, 100, readCursor(url.searchParams.get("cursor"))),
				BACKGROUND_CONTEXT,
			);
			nextCursor = tasks.next;
			let hostLog = "";
			try {
				const file = await open(join(options.workingDir, "service.log"), "r");
				try {
					const size = (await file.stat()).size;
					const buffer = Buffer.alloc(Math.min(size, 50000));
					const read = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
					hostLog = buffer.subarray(0, read.bytesRead).toString();
				} finally {
					await file.close();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			value = { tasks, hostLog };
		} else if (page === "/memory") {
			const root = join(options.workingDir, "skills", "file-memory", "namespaces");
			const files = await readdir(root, { recursive: true }).catch((error) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
			value = await Promise.all(
				files
					.filter((file) => file.endsWith(".jsonl"))
					.slice(0, 100)
					.map(async (file) => ({
						namespace: file.slice(0, -6),
						records: (await readFile(join(root, file), "utf8")).slice(0, 50000),
					})),
			);
		} else {
			json(response, 404, { error: "Not found" });
			return;
		}
		if (url.pathname.endsWith("/data")) {
			json(response, 200, value);
			return;
		}
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		const next = new URL(url);
		if (nextCursor)
			next.searchParams.set("cursor", Buffer.from(JSON.stringify(nextCursor)).toString("base64url"));
		const conversations = await options.agent.harness.commit(
			(tx) => tx.scanConversations({}, 100),
			BACKGROUND_CONTEXT,
		);
		const links = conversations.items
			.map((conversation) => `<a href="/chat?conversationId=${conversation.id}">${conversation.id}</a>`)
			.join(" | ");
		const dataPath = page === "/" ? "/chat/data" : `${page}/data`;
		const dataURL = JSON.stringify(dataPath + url.search).replaceAll("<", "\\u003c");
		response.end(
			`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>pi-imessage</title><style>body{font:13px/1.6 monospace;max-width:1000px;margin:20px auto;padding:0 16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit}</style></head><body><nav><a href="/">State</a> | <a href="/settings">Settings</a> | <a href="/scheduled">Scheduled</a> | <a href="/memory">Memory</a> | <a href="/logs">Logs</a> | <a href="/automation">Automation</a></nav><p>Conversations: ${links}</p><pre id="state">${escapeHtml(redact(value))}</pre>${nextCursor ? `<a href="${escapeHtml(next.pathname + next.search)}">Next page</a>` : ""}<script>const state=document.getElementById('state');const events=new EventSource('/events');let pending=false;events.onmessage=()=>{if(pending)return;pending=true;setTimeout(async()=>{try{const response=await fetch(${dataURL});if(response.ok)state.textContent=JSON.stringify(await response.json(),null,2);}finally{pending=false;}},1000);};setInterval(()=>events.onmessage(),5000);</script></body></html>`,
		);
	}
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 7750, options.host ?? "localhost", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing web server address");
	return {
		address,
		async close() {
			for (const [stream, unsubscribe] of streams) {
				unsubscribe();
				stream.end();
			}
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
