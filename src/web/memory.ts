import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryQueryError, parseMemoryQuery, readMemoryView } from "../memory-view.js";
import { renderMemoryPage } from "./render.js";

/** Standalone read-only handler; also used with disposable fixture-only HTTP servers. */
export function handleMemoryRequest(
	request: IncomingMessage,
	response: ServerResponse,
	workingDir: string,
	agentRoot?: string
): boolean {
	const path = (request.url || "").split("?")[0];
	if (path !== "/memory" && !path.startsWith("/memory/")) return false;
	const headers = {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		"Referrer-Policy": "no-referrer",
	};
	const json = (status: number, data: unknown) => {
		response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(data));
	};
	if (request.method !== "GET") {
		response.setHeader("Allow", "GET");
		json(405, { error: "Memory 仅供只读查看" });
		return true;
	}
	if (path !== "/memory" && path !== "/memory/data") {
		json(404, { error: "未知 Memory 路由" });
		return true;
	}
	try {
		if ((request.url || "").length > 2048) throw new MemoryQueryError("请求参数过长");
		const url = new URL(request.url || "/memory", "http://localhost");
		const data = readMemoryView(workingDir, parseMemoryQuery(url.searchParams), agentRoot);
		if (path === "/memory/data") json(200, data);
		else {
			const html = renderMemoryPage(data);
			response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
			response.end(html);
		}
	} catch (error) {
		if (error instanceof MemoryQueryError) json(400, { error: error.message });
		else {
			// Do not log source text, query strings, or filesystem paths.
			console.warn("[web] read-only Memory snapshot/render failed; returning explicit unavailable response");
			json(500, { error: "记忆视图不可用；未执行任何修改" });
		}
	}
	return true;
}
