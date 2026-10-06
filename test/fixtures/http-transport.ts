import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { openHttpTransport } from "../../src/transport/http.ts";

// #33 / ADR 0016: a separate process owns only loopback HTTP fixtures, never installed auth or models.
const previousFetch = globalThis.fetch;
const previousDispatcher = getGlobalDispatcher();
const previousRequest = globalThis.Request;
const sockets = new Set<Duplex>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let slowResponse: ServerResponse | undefined;
let owner: ReturnType<typeof openHttpTransport> | undefined;
let external: Agent | undefined;
const direct = createServer((request, response) => {
	if (request.url === "/headers") return;
	if (request.url === "/body") {
		response.writeHead(200);
		response.write("unfinished");
		return;
	}
	if (request.url === "/slow") {
		slowResponse = response;
		response.write("before");
		return;
	}
	if (request.url === "/delay") {
		const timer = setTimeout(() => response.end("delayed"), 250);
		timers.add(timer);
		return;
	}
	response.setHeader("Content-Encoding", "gzip");
	response.end(gzipSync(JSON.stringify({ source: "direct" })));
});
const proxyCounts = [0, 0];
const proxies = [0, 1].map((index) => {
	const proxy = createServer();
	proxy.on("connect", (_request, socket) => {
		proxyCounts[index]++;
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.once("data", () => {
			// A synthetic tunnel: plain HTTP gets gzipped JSON; TLS intentionally fails locally.
			const body = gzipSync(JSON.stringify({ source: `proxy-${index}` }));
			socket.end(
				Buffer.concat([
					Buffer.from(
						`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
					),
					body,
				]),
			);
		});
	});
	return proxy;
});
const servers = [direct, ...proxies];
for (const server of servers)
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});

try {
	for (const server of servers) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const urls = servers.map((server) => {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	});
	const [directUrl, firstProxy, secondProxy] = urls;
	const read = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(3000) })).json();
	owner = openHttpTransport({ proxy: firstProxy, idleTimeoutMs: 0 });
	assert.notEqual(getGlobalDispatcher(), previousDispatcher);
	assert.notEqual(globalThis.fetch, previousFetch);
	assert.equal(await read("http://imessage-fixture.invalid/gzip").then((value) => value.source), "proxy-0");
	assert.throws(() => openHttpTransport({ idleTimeoutMs: 0 }), /process owner/);

	// Explicit environment values win; lowercase values win over uppercase, including bypass rules.
	process.env.HTTP_PROXY = secondProxy;
	owner.reload({ proxy: firstProxy, idleTimeoutMs: 0 });
	assert.deepEqual(await read("http://imessage-fixture.invalid/gzip"), { source: "proxy-1" });
	process.env.http_proxy = firstProxy;
	process.env.HTTPS_PROXY = secondProxy;
	process.env.https_proxy = firstProxy;
	process.env.NO_PROXY = "*";
	process.env.no_proxy = "";
	owner.reload({ proxy: secondProxy, idleTimeoutMs: 0 });
	assert.deepEqual(await read("http://imessage-fixture.invalid/gzip"), { source: "proxy-0" });
	const connects = proxyCounts[0];
	await assert.rejects(fetch("https://imessage-fixture.invalid/", { signal: AbortSignal.timeout(3000) }));
	assert.equal(proxyCounts[0], connects + 1);
	delete process.env.https_proxy;
	owner.reload({ proxy: firstProxy, idleTimeoutMs: 0 });
	const upperConnects = proxyCounts[1];
	await assert.rejects(fetch("https://imessage-fixture.invalid/", { signal: AbortSignal.timeout(3000) }));
	assert.equal(proxyCounts[1], upperConnects + 1);
	process.env.no_proxy = "127.0.0.1";
	owner.reload({ proxy: secondProxy, idleTimeoutMs: 0 });
	assert.deepEqual(await read(`${directUrl}/gzip`), { source: "direct" });
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"])
		delete process.env[name];

	// Removing the configured default on reload must not leave a stale environment proxy behind.
	owner.reload({ idleTimeoutMs: 80 });
	assert.deepEqual(await read(`${directUrl}/gzip`), { source: "direct" });
	const installed = getGlobalDispatcher();
	assert.throws(() => owner?.reload({ idleTimeoutMs: -1 }), /Invalid HTTP idle timeout/);
	assert.equal(getGlobalDispatcher(), installed);
	for (const [path, code] of [
		["headers", "UND_ERR_HEADERS_TIMEOUT"],
		["body", "UND_ERR_BODY_TIMEOUT"],
	])
		await assert.rejects(
			async () => (await fetch(`${directUrl}/${path}`, { signal: AbortSignal.timeout(3000) })).text(),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal((error.cause as { code?: string })?.code, code);
				return true;
			},
		);
	owner.reload({ idleTimeoutMs: 0 });
	assert.equal(
		await (await fetch(`${directUrl}/delay`, { signal: AbortSignal.timeout(3000) })).text(),
		"delayed",
	);

	// Reload drains the old client without cancelling a streaming response or blocking new requests.
	const slow = await fetch(`${directUrl}/slow`, { signal: AbortSignal.timeout(3000) });
	const oldDispatcher = getGlobalDispatcher();
	owner.reload({ proxy: secondProxy, idleTimeoutMs: 0 });
	assert.notEqual(getGlobalDispatcher(), oldDispatcher);
	assert.deepEqual(await read("http://imessage-fixture.invalid/gzip"), { source: "proxy-1" });
	slowResponse?.end("after");
	assert.equal(await slow.text(), "beforeafter");
	const closing = owner.close();
	assert.equal(owner.close(), closing);
	await closing;
	assert.equal(getGlobalDispatcher(), previousDispatcher);
	assert.equal(globalThis.fetch, previousFetch);
	assert.equal(globalThis.Request, previousRequest);
	assert.equal(process.env.HTTP_PROXY, undefined);

	// Deliberate fetch overrides and another caller's dispatcher survive reload and shutdown.
	const customFetch: typeof fetch = async () => new Response("custom");
	globalThis.fetch = customFetch;
	owner = openHttpTransport({ proxy: firstProxy, idleTimeoutMs: 0 });
	assert.equal(globalThis.fetch, customFetch);
	owner.reload({ proxy: secondProxy, idleTimeoutMs: 0 });
	assert.equal(globalThis.fetch, customFetch);
	external = new Agent();
	setGlobalDispatcher(external);
	assert.throws(() => owner?.reload({ idleTimeoutMs: 0 }), /ownership changed/);
	await owner.close();
	assert.equal(getGlobalDispatcher(), external);
	assert.equal(external.closed, false);
	assert.equal(globalThis.fetch, customFetch);
	console.log("HTTP transport verified");
} finally {
	slowResponse?.end();
	for (const timer of timers) clearTimeout(timer);
	for (const socket of sockets) socket.destroy();
	await owner?.close();
	await external?.close();
	globalThis.fetch = previousFetch;
	setGlobalDispatcher(previousDispatcher);
	await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}
