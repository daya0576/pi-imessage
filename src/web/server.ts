import { randomUUID } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type Cursor,
	type Harness,
	LiveDoc,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Chats } from "../agent/chats.ts";
import { DirectSends } from "../agent/direct-send.ts";
import { Sessions } from "../agent/health.ts";
import { Deliveries } from "../agent/replies.ts";
import { Schedules } from "../agent/scheduling.ts";
import { readSettings } from "../config/settings.ts";
import { createReadCache } from "./cache.ts";
import { displayHistory, historyActivity } from "./history.ts";
import { memoryPage, parseMemoryFile } from "./memory.ts";
import { renderPage } from "./page.ts";
import { readSchedules } from "./schedules.ts";
import { readTaskTree } from "./tasks.ts";

export interface WebAgent {
	harness: Harness;
	health(): Promise<{ ok: boolean; model: string; latencyMs: number; checkedAt: string }>;
}
function readCursor(value: string | null): Cursor | undefined {
	if (!value) return;
	if (value.length > 2048) throw new Error("Invalid cursor");
	const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid cursor");
	return parsed as Cursor;
}
function redact(value: unknown, compact = false, truncateStrings = true): string {
	return JSON.stringify(
		value,
		(key, item) =>
			/^(authorization|password|api[_-]?key|(?:(?:access|refresh)[_-]?)?token|secret|credentials?)$/i.test(
				key,
			)
				? "[redacted]"
				: truncateStrings && typeof item === "string" && item.length > 50000
					? `${item.slice(0, 50000)}\n[truncated]`
					: item,
		compact ? undefined : 2,
	)
		.replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,})\b/g, "[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}
const compress = promisify(gzip);
async function send(response: ServerResponse, status: number, contentType: string, text: string) {
	const encodings = new Map(
		(response.req.headers["accept-encoding"] ?? "").split(",").map((item) => {
			const [name, ...parameters] = item.trim().toLowerCase().split(";");
			const quality = parameters
				.map((parameter) => parameter.trim())
				.find((parameter) => parameter.startsWith("q="));
			return [name.trim(), quality ? Number(quality.slice(2)) : 1] as const;
		}),
	);
	const body = Buffer.from(text);
	const useGzip = body.length >= 1024 && (encodings.get("gzip") ?? encodings.get("*") ?? 0) > 0;
	const payload = useGzip ? await compress(body) : body;
	response.writeHead(status, {
		"Content-Type": contentType,
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		Vary: "Accept-Encoding",
		"Content-Length": payload.length,
		...(useGzip ? { "Content-Encoding": "gzip" } : {}),
	});
	response.end(payload);
}
function json(
	response: ServerResponse,
	status: number,
	value: unknown,
	compact = false,
	truncateStrings = true,
) {
	return send(response, status, "application/json; charset=utf-8", redact(value, compact, truncateStrings));
}

/** Read-only pages and an explicit model health check. Viewing pages never starts work. */
export async function startWeb(options: {
	workingDir: string;
	agent: WebAgent;
	host?: string;
	port?: number;
}) {
	const streams = new Map<ServerResponse, () => void>();
	const cache = createReadCache();
	let revision = 0;
	const instance = randomUUID();
	function viewRevision() {
		return `${instance}:${revision}`;
	}
	function nativeRead<T>(key: string, load: () => Promise<T>) {
		return cache.read(`native:${key}`, () => revision, load);
	}
	async function fileRead<T>(path: string | URL, load: () => Promise<T>, variant = "default") {
		return cache.read(
			`file:${variant}:${path}`,
			async () => {
				try {
					const info = await stat(path, { bigint: true });
					return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
					throw error;
				}
			},
			load,
		);
	}
	function settings() {
		return fileRead(join(options.workingDir, "settings.json"), () => readSettings(options.workingDir));
	}
	function history(id: ConversationId, cursor?: Cursor) {
		return nativeRead(`history:${id}:${JSON.stringify(cursor)}`, async () => {
			const conversation = await options.agent.harness.conversation(id, BACKGROUND_CONTEXT);
			if (!conversation) throw new Error("Conversation not found");
			return conversation.entries({}, 100, cursor, BACKGROUND_CONTEXT);
		});
	}
	function delivery(id: ConversationId) {
		return nativeRead(`delivery:${id}`, () =>
			options.agent.harness.snapshot(Deliveries, id, BACKGROUND_CONTEXT),
		);
	}
	async function overview() {
		const [view, configuration] = await Promise.all([
			nativeRead("overview", async () => {
				const chats = await nativeRead("chats", () =>
					options.agent.harness.snapshot(Chats, BACKGROUND_CONTEXT),
				);
				const conversations = await Promise.all(
					(chats?.items ?? []).map(async (chat) => {
						try {
							const [entries, receipt] = await Promise.all([
								history(chat.conversationId),
								delivery(chat.conversationId),
							]);
							const { items, groupName } = displayHistory(entries, 15);
							return {
								...chat,
								updatedAt: historyActivity(entries),
								history: { items, groupName },
								delivery: {
									answers: Object.fromEntries(items.map((entry) => [entry.id, receipt?.answers[entry.id]])),
									drafts: Object.fromEntries(items.map((entry) => [entry.id, receipt?.drafts?.[entry.id]])),
								},
							};
						} catch (error) {
							return { ...chat, error: error instanceof Error ? error.message : String(error) };
						}
					}),
				);
				if (conversations.some((chat) => "error" in chat)) cache.delete("native:overview");
				return { conversations, revision: viewRevision() };
			}),
			settings(),
		]);
		return { ...view, settings: { chatAllowlist: configuration.chatAllowlist } };
	}
	const server = createServer((request, response) => {
		void handle(request, response).catch((error) => {
			if (!response.headersSent)
				void json(response, 400, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}).catch(() => response.destroy());
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
			await json(response, 403, { error: "Cross-origin requests are not allowed" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/health/model") {
			try {
				await json(response, 200, await options.agent.health());
			} catch (error) {
				await json(response, 503, {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		if (request.method !== "GET") {
			await json(response, 404, { error: "Not found" });
			return;
		}
		if (url.pathname === "/events") {
			response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
			response.write(`event: ready\ndata: ${JSON.stringify({ revision: viewRevision() })}\n\n`);
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
		const asset =
			url.pathname === "/assets/style.css"
				? "style.css"
				: url.pathname === "/assets/app.js"
					? "app.js"
					: undefined;
		if (asset) {
			const path = new URL(asset, import.meta.url);
			await send(
				response,
				200,
				asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
				await fileRead(path, () => readFile(path, "utf8")),
			);
			return;
		}
		let value: unknown;
		let compact = false;
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
					await json(response, 404, { error: "Conversation not found" });
					return;
				}
				const cursor = readCursor(url.searchParams.get("cursor"));
				const detail = await nativeRead(`detail:${id}:${JSON.stringify(cursor)}`, async () => ({
					history: await history(conversation.id, cursor),
					delivery: await delivery(conversation.id),
					live: await options.agent.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT),
					revision: viewRevision(),
				}));
				if (!url.pathname.endsWith("/data") || url.searchParams.get("view") === "display") {
					const [chats, configuration] = await Promise.all([
						nativeRead("chats", () => options.agent.harness.snapshot(Chats, BACKGROUND_CONTEXT)),
						settings(),
					]);
					value = {
						history: displayHistory(detail.history),
						delivery: detail.delivery,
						chat: chats?.items.find((chat) => chat.conversationId === conversation.id),
						settings: { chatAllowlist: configuration.chatAllowlist },
						revision: detail.revision,
					};
					compact = true;
				} else
					value = {
						history: detail.history,
						delivery: detail.delivery,
						live: detail.live,
						agent: await conversation.agent(BACKGROUND_CONTEXT),
					};
			} else if (!url.pathname.endsWith("/data") || url.searchParams.get("view") === "overview") {
				value = await overview();
				compact = true;
			} else
				value = {
					...(await nativeRead("index", async () => ({
						chats: await nativeRead("chats", () => options.agent.harness.snapshot(Chats, BACKGROUND_CONTEXT)),
						sessions: await options.agent.harness.snapshot(Sessions, BACKGROUND_CONTEXT),
						tasks: await nativeRead("tasks:", () =>
							options.agent.harness.commit((tx) => tx.scanTasks({}, 100), BACKGROUND_CONTEXT),
						),
						sends: await options.agent.harness.snapshot(DirectSends, BACKGROUND_CONTEXT),
					}))),
					inspection: await options.agent.harness.inspect(BACKGROUND_CONTEXT),
				};
		} else if (page === "/scheduled") {
			value = await nativeRead("schedules", () => readSchedules(options.agent.harness));
			compact = true;
		} else if (page === "/tasks") {
			value = await nativeRead("task-tree", async () => ({
				...(await readTaskTree(options.agent.harness)),
				schedules: await options.agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT),
				chats: await nativeRead("chats", () => options.agent.harness.snapshot(Chats, BACKGROUND_CONTEXT)),
				sessions: await nativeRead("sessions", () =>
					options.agent.harness.snapshot(Sessions, BACKGROUND_CONTEXT),
				),
				revision: viewRevision(),
			}));
			compact = true;
		} else if (url.pathname === "/tasks/task/data") {
			const id = url.searchParams.get("taskId");
			if (!id || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Invalid task ID");
			value = await nativeRead(`task:${id}`, () =>
				options.agent.harness.getTask(Number(id) as TaskId, BACKGROUND_CONTEXT),
			);
			if (!value) {
				await json(response, 404, { error: "Task not found" });
				return;
			}
		} else if (page === "/settings") value = await settings();
		else if (page === "/logs") {
			const cursor = readCursor(url.searchParams.get("cursor"));
			const tasks = await nativeRead(`tasks:${JSON.stringify(cursor) ?? ""}`, () =>
				options.agent.harness.commit((tx) => tx.scanTasks({}, 100, cursor), BACKGROUND_CONTEXT),
			);
			const hostLog = await fileRead(join(options.workingDir, "service.log"), async () => {
				try {
					const file = await open(join(options.workingDir, "service.log"), "r");
					try {
						const size = (await file.stat()).size;
						const buffer = Buffer.alloc(Math.min(size, 50000));
						const read = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
						return buffer.subarray(0, read.bytesRead).toString();
					} finally {
						await file.close();
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					return "";
				}
			});
			value = { tasks, hostLog };
		} else if (page === "/memory") {
			const root = join(options.workingDir, "skills", "file-memory", "namespaces");
			const files = await readdir(root, { recursive: true }).catch((error) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
			const namespaces = files.filter((file) => file.endsWith(".jsonl")).sort();
			if (!url.pathname.endsWith("/data") || url.searchParams.get("view") === "records") {
				const records = await Promise.all(
					namespaces.map((file) =>
						fileRead(
							join(root, file),
							async () => parseMemoryFile(await readFile(join(root, file), "utf8"), file.slice(0, -6)),
							"records",
						),
					),
				);
				value = memoryPage(records, url.searchParams);
				compact = true;
			} else {
				// Keep the raw namespace API shape, but never cut a JSONL record in half.
				value = await Promise.all(
					namespaces.map(async (file) => ({
						namespace: file.slice(0, -6),
						records: await fileRead(join(root, file), () => readFile(join(root, file), "utf8")),
					})),
				);
			}
		} else {
			await json(response, 404, { error: "Not found" });
			return;
		}
		if (url.pathname.endsWith("/data")) {
			await json(response, 200, value, compact, page !== "/memory");
			return;
		}
		await send(
			response,
			200,
			"text/html; charset=utf-8",
			renderPage(page, redact(value, compact, page !== "/memory")),
		);
	}
	const unsubscribeCache = options.agent.harness.subscribeCommits((publication) => {
		if (publication.changes.length) revision++;
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 7750, options.host ?? "localhost", () => {
			server.off("error", reject);
			resolve();
		});
	}).catch((error) => {
		unsubscribeCache();
		throw error;
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing web server address");
	return {
		address,
		async close() {
			unsubscribeCache();
			cache.clear();
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
