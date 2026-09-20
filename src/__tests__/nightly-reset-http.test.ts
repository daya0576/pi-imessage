import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebServerConfig, createWebServer } from "../web/index.js";

const control = vi.hoisted(() => ({
	handle: undefined as undefined | ((request: IncomingMessage, response: ServerResponse) => Promise<void>),
}));
vi.mock("node:http", () => ({
	createServer: (handler: typeof control.handle) => {
		control.handle = handler;
		return { listen: vi.fn(), close: vi.fn(), on: vi.fn() };
	},
}));
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "synthetic-reset-http-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function request(
	method: string,
	body = "",
	headers: Record<string, string> = { "x-session-reset": "nightly-reflection" },
	query = ""
) {
	const incoming = Object.assign(new EventEmitter(), {
		method,
		url: `/maintenance/nightly-reset${query}`,
		headers,
		socket: { remoteAddress: "127.0.0.1" },
	});
	let status = 0;
	let result: Record<string, unknown> = {};
	let finish = () => {};
	const ended = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const response = {
		writeHead: (code: number) => {
			status = code;
		},
		end: (data: string) => {
			result = JSON.parse(data);
			finish();
		},
	};
	const operation = control.handle?.(incoming as unknown as IncomingMessage, response as unknown as ServerResponse);
	// Handler awaits the unrelated automation-router check before installing body listeners.
	for (let step = 0; step < 10; step++) await Promise.resolve();
	incoming.emit("data", Buffer.from(body));
	incoming.emit("end");
	await operation;
	await ended;
	return { status, result };
}

describe("nightly reset real HTTP handler without sockets or model calls", () => {
	it("validates local guard, returns settled receipt, and deduplicates repeated POST", async () => {
		const chatGuid = "iMessage;+;chat1";
		mkdirSync(join(root, chatGuid));
		writeFileSync(join(root, chatGuid, "context.jsonl"), "synthetic");
		const newSession = vi.fn(async () => {});
		createWebServer({
			workingDir: root,
			port: 0,
			agent: { newSession, getRuntimeStatus: () => ({ sessionSettings: [] }) },
		} as unknown as WebServerConfig);
		expect((await request("POST", "{}", {})).status).toBe(403);
		expect(newSession).not.toHaveBeenCalled();
		const body = JSON.stringify({ runId: "nightly-reset-2026-09-17" });
		const first = await request("POST", body);
		expect(first.status).toBe(200);
		expect(first.result.status).toBe("completed");
		expect((await request("POST", body)).result).toEqual(first.result);
		expect((await request("GET", "", undefined, "?runId=nightly-reset-2026-09-17")).result).toEqual(first.result);
		expect(newSession).toHaveBeenCalledTimes(1);
	});
});
