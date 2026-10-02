/** Web server: serves the chat log UI, logs page, and API endpoints. */

import { existsSync, readFileSync, watch } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentManager, resolveSessionStorage } from "../agent.js";
import type { AutomationService } from "../automation.js";
import type { CronService } from "../cron.js";
import type { ModelHealthChecker } from "../model-health.js";
import { allowsNightlyReset, createNightlyReset } from "../nightly-reset.js";
import { REMINDER_STATUSES, type ReminderService, type ReminderStatus } from "../reminders.js";
import type { SelfEchoFilter } from "../self-echo.js";
import type { MessageSender } from "../send.js";
import type { Settings } from "../settings.js";
import type { AgentReply } from "../types.js";
import { handleAutomationRequest } from "./automation.js";
import { getChatBlocks } from "./data.js";
import { handleMemoryRequest } from "./memory.js";
import { renderLogsPage, renderPage, renderScheduledPage } from "./render.js";
import { handleSourcesRequest } from "./sources.js";

export interface WebServerConfig {
	workingDir: string;
	host: string;
	port: number;
	getSettings: () => Settings;
	setSettings: (settings: Settings) => void;
	sender: MessageSender;
	echoFilter: SelfEchoFilter;
	agent: AgentManager;
	checkModelHealth: ModelHealthChecker;
	reminders: ReminderService;
	cron: CronService;
	automation?: AutomationService;
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
	const {
		workingDir,
		host,
		port,
		getSettings,
		setSettings,
		sender,
		echoFilter,
		agent,
		checkModelHealth,
		reminders,
		cron,
	} = config;
	const nightlyReset = agent.getRuntimeStatus
		? createNightlyReset(workingDir, { newSession: agent.newSession, getRuntimeStatus: agent.getRuntimeStatus })
		: undefined;
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
				if (
					filename?.endsWith("log.jsonl") ||
					filename?.endsWith(".log") ||
					filename?.endsWith("core.md") ||
					filename?.endsWith("SYSTEM.md") ||
					filename?.endsWith("SKILL.md") ||
					(filename?.includes("file-memory") && filename.endsWith(".jsonl"))
				) {
					broadcast();
				}
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
		if (handleMemoryRequest(request, response, workingDir, getAgentDir())) return;
		if (handleSourcesRequest(request, response, workingDir)) return;
		if (await handleAutomationRequest(request, response, config.automation)) return;
		const url = new URL(request.url ?? "/", `http://localhost:${port}`);

		if (url.pathname === "/maintenance/nightly-reset") {
			if (
				!allowsNightlyReset(request.socket.remoteAddress, request.headers.origin, request.headers["x-session-reset"])
			) {
				jsonResponse(response, 403, { error: "Local maintenance only" });
				return;
			}
			if (!nightlyReset || process.env.WORKER_ENABLED === "false") {
				jsonResponse(response, 503, { error: "Session reset unavailable on an inactive worker" });
				return;
			}
			try {
				if (request.method === "GET") {
					const receipt = nightlyReset.inspect(url.searchParams.get("runId") ?? "");
					jsonResponse(response, receipt ? 200 : 404, receipt ?? { error: "No receipt" });
				} else if (request.method === "POST") {
					const body = await parseJsonBody(request);
					if (typeof body.runId !== "string") throw new Error("runId required");
					const receipt = await nightlyReset.reset(body.runId);
					jsonResponse(response, receipt.status === "completed" ? 200 : 409, receipt);
				} else {
					jsonResponse(response, 405, { error: "Method not allowed" });
				}
			} catch {
				console.error("[nightly-reset] request failed; inspect durable receipt, do not replay");
				jsonResponse(response, 409, { error: "Reset unconfirmed; inspect receipt before further action" });
			}
			return;
		}

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

		// Unified recurring jobs and one-time reminders page.
		if (url.pathname === "/scheduled" && request.method === "GET") {
			const html = renderScheduledPage({
				jobs: cron.list(),
				runs: cron.listRuns(100),
				reminders: reminders.list(),
				configPath: cron.configPath,
			});
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(html);
			return;
		}

		if (url.pathname === "/scheduled/data" && request.method === "GET") {
			jsonResponse(response, 200, {
				jobs: cron.list(),
				runs: cron.listRuns(100),
				reminders: reminders.list(),
				configPath: cron.configPath,
			});
			return;
		}

		const cronRunMatch = url.pathname.match(/^\/cron\/jobs\/([^/]+)\/run$/);
		if (request.method === "POST" && cronRunMatch) {
			try {
				const run = await cron.runNow(decodeURIComponent(cronRunMatch[1]));
				jsonResponse(response, 200, { ok: true, run });
			} catch (error) {
				jsonResponse(response, 404, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		const cronToggleMatch = url.pathname.match(/^\/cron\/jobs\/([^/]+)\/enabled$/);
		if (request.method === "POST" && cronToggleMatch) {
			try {
				const body = await parseJsonBody(request);
				if (typeof body.enabled !== "boolean") throw new Error("enabled must be boolean");
				const job = cron.setEnabled(decodeURIComponent(cronToggleMatch[1]), body.enabled);
				jsonResponse(response, 200, { ok: true, job });
			} catch (error) {
				jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
			}
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

		// Logs data API (JSON)
		if (url.pathname === "/logs/data" && request.method === "GET") {
			const appLog = readLogTail(join(workingDir, "app.log"), 200);
			const digestLog = readLogTail(join(workingDir, "digest.log"), 200);
			jsonResponse(response, 200, { appLog, digestLog });
			return;
		}

		// GET /health/runtime — lightweight readiness/drain state for deployment.
		if (request.method === "GET" && url.pathname === "/health/runtime") {
			const runtime = agent.getRuntimeStatus?.() ?? { activePrompts: 0, sessions: 0, lastAgentActivityAt: null };
			jsonResponse(response, 200, { ok: true, ...runtime });
			return;
		}

		// GET /health/model — make a live request to the configured default AI model
		if (request.method === "GET" && url.pathname === "/health/model") {
			const result = await checkModelHealth();
			jsonResponse(response, result.ok ? 200 : 503, result);
			return;
		}

		// GET /reminders — list persisted reminders, optionally filtered by status
		if (request.method === "GET" && url.pathname === "/reminders") {
			const statusParam = url.searchParams.get("status");
			if (statusParam && !REMINDER_STATUSES.includes(statusParam as ReminderStatus)) {
				jsonResponse(response, 400, { error: `invalid status: ${statusParam}` });
				return;
			}
			const status = (statusParam || undefined) as ReminderStatus | undefined;
			jsonResponse(response, 200, { reminders: reminders.list(status) });
			return;
		}

		// POST /reminders — persist a one-time reminder and deliver it at the requested instant
		if (request.method === "POST" && url.pathname === "/reminders") {
			try {
				const body = await parseJsonBody(request);
				if (
					typeof body.chatGuid !== "string" ||
					typeof body.text !== "string" ||
					typeof body.scheduledAt !== "string"
				) {
					jsonResponse(response, 400, { error: "chatGuid, text, and scheduledAt are required strings" });
					return;
				}
				if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
					jsonResponse(response, 400, { error: "idempotencyKey must be a string" });
					return;
				}
				const result = reminders.create({
					chatGuid: body.chatGuid,
					text: body.text,
					scheduledAt: body.scheduledAt,
					idempotencyKey: body.idempotencyKey,
				});
				jsonResponse(response, result.created ? 201 : 200, { ok: true, ...result });
			} catch (error) {
				jsonResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		// DELETE /reminders/:id — cancel a pending reminder
		const reminderMatch = url.pathname.match(/^\/reminders\/([^/]+)$/);
		if (request.method === "DELETE" && reminderMatch) {
			const reminder = reminders.cancel(decodeURIComponent(reminderMatch[1]));
			if (!reminder) {
				jsonResponse(response, 404, { error: "pending reminder not found" });
				return;
			}
			jsonResponse(response, 200, { ok: true, reminder });
			return;
		}

		// POST /send — send a message and/or local file attachment directly to a chat
		if (request.method === "POST" && url.pathname === "/send") {
			try {
				const body = await parseJsonBody(request);
				const chatGuid = body.chatGuid as string;
				const text = body.text as string | undefined;
				const filePath = (body.filePath ?? body.attachmentPath) as string | undefined;
				if (!chatGuid || (!text && !filePath)) {
					jsonResponse(response, 400, { error: "chatGuid and text or filePath required" });
					return;
				}
				if (text) {
					echoFilter.remember(chatGuid, text);
					await sender.sendMessage(chatGuid, text);
				}
				if (filePath) {
					await sender.sendAttachment(chatGuid, filePath);
				}
				console.log(
					`[web] /send: ${chatGuid} text=${text ? `"${text.substring(0, 60)}"` : "none"} file=${filePath ?? "none"}`
				);
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
				const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined;
				const ephemeral = body.ephemeral === true;
				if (!chatGuid || !prompt) {
					jsonResponse(response, 400, { error: "chatGuid and prompt required" });
					return;
				}
				try {
					resolveSessionStorage(workingDir, chatGuid, { sessionKey, ephemeral });
				} catch (error) {
					jsonResponse(response, 400, { error: String(error) });
					return;
				}
				console.log(
					`[web] /prompt: ${chatGuid} session=${sessionKey ?? chatGuid} ephemeral=${ephemeral} "${prompt.substring(0, 60)}"`
				);
				jsonResponse(response, 200, { ok: true });
				// Process asynchronously — agent replies are sent to the chat when ready
				agent
					.processMessage(
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
							if (agentReply.kind === "assistant") {
								echoFilter.remember(chatGuid, agentReply.text);
								await sender.sendMessage(chatGuid, agentReply.text);
							}
						},
						{ streamingBehavior: "followUp", sessionKey, ephemeral }
					)
					.then(() => {
						console.log(`[web] /prompt done: ${chatGuid}`);
					})
					.catch((error) => {
						console.error(`[web] /prompt error: ${chatGuid}`, error);
					});
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
