import type { IncomingMessage, ServerResponse } from "node:http";
import { readSources } from "../sources.js";
import { renderSourcesPage } from "./render.js";

export function handleSourcesRequest(request: IncomingMessage, response: ServerResponse, workingDir: string): boolean {
	const path = (request.url ?? "").split("?")[0];
	if (path !== "/sources" && !path.startsWith("/sources/")) return false;
	const json = (status: number, data: unknown) => {
		response.writeHead(status, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(JSON.stringify(data));
	};
	if (request.method !== "GET") {
		json(405, { error: "Sources is read-only; configure connectors locally after review." });
		return true;
	}
	if (!["/sources", "/sources/data"].includes(path)) {
		json(404, { error: "Unknown source route" });
		return true;
	}
	const data = readSources(workingDir);
	if (path === "/sources/data") json(200, data);
	else {
		const html = renderSourcesPage(data);
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(html);
	}
	return true;
}
