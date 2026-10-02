import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutomationService } from "../automation.js";
import { renderTasksPage } from "./render.js";

export async function handleAutomationRequest(
	request: IncomingMessage,
	response: ServerResponse,
	service?: AutomationService
): Promise<boolean> {
	const path = (request.url ?? "").split("?")[0];
	if (path !== "/tasks" && !path.startsWith("/tasks/")) return false;
	const json = (status: number, data: unknown) => {
		response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		response.end(JSON.stringify(data));
	};
	try {
		if (request.method === "GET" && ["/tasks", "/tasks/data"].includes(path)) {
			const data = { tasks: service?.list() ?? [], runs: service?.listRuns() ?? [] };
			if (path === "/tasks/data") json(200, data);
			else {
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				response.end(renderTasksPage(data));
			}
			return true;
		}
		const match = path.match(/^\/tasks\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/(run|pause|resume)$/);
		if (request.method !== "POST" || !match) {
			json(404, { error: "Unknown task route" });
			return true;
		}
		// No CORS, forwarded-host trust, form posts, or origin-less mutations.
		if (
			request.headers.origin !== `http://${request.headers.host}` ||
			(request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") ||
			request.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
			request.headers["x-automation-action"] !== "1"
		) {
			json(403, { error: "Same-origin JSON request required" });
			return true;
		}
		let body = "";
		for await (const chunk of request) {
			body += chunk.toString();
			if (Buffer.byteLength(body) > 1024) {
				json(413, { error: "Body too large" });
				return true;
			}
		}
		const parsed = JSON.parse(body);
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).length) {
			json(400, { error: "Expected empty JSON object" });
			return true;
		}
		if (!service) {
			json(503, { error: "Automation unavailable" });
			return true;
		}
		try {
			service.action(match[1], match[2] as "run" | "pause" | "resume");
			json(202, { status: "accepted" });
		} catch {
			json(409, { error: "Task unavailable. Check worker, pause, or termination state." });
		}
	} catch {
		json(400, { error: "Invalid task request" });
	}
	return true;
}
