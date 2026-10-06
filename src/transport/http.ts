import { EventEmitter } from "node:events";
import {
	Client,
	type Dispatcher,
	EnvHttpProxyAgent,
	getGlobalDispatcher,
	install,
	Pool,
	setGlobalDispatcher,
} from "undici";

const initialFetch = globalThis.fetch;
const fetchGlobals = [
	"fetch",
	"Headers",
	"Response",
	"Request",
	"FormData",
	"WebSocket",
	"CloseEvent",
	"ErrorEvent",
	"MessageEvent",
	"EventSource",
];
let processOwned = false;

// A terminated body still rejects its reader. Avoid an unhandled Client error crashing the process.
function listenForClientErrors<T extends Dispatcher>(dispatcher: T): T {
	EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	return dispatcher;
}

function createClient(origin: string | URL, options: Client.Options) {
	return listenForClientErrors(new Client(origin, options));
}

/** One process owner; settings are defaults beneath explicit environment proxy values. */
export function openHttpTransport(settings: { proxy?: string; idleTimeoutMs: number }) {
	if (processOwned) throw new Error("HTTP transport already has a process owner");
	const previousDispatcher = getGlobalDispatcher();
	const globals: { name: string; previous?: PropertyDescriptor; installed?: PropertyDescriptor }[] = [];
	const retiring = new Set<Promise<void>>();
	let retirementError: unknown;
	let current: EnvHttpProxyAgent | undefined;
	let closing: Promise<void> | undefined;

	function retire(dispatcher: EnvHttpProxyAgent) {
		const pending = dispatcher
			.close()
			.catch((error: unknown) => {
				retirementError ??= error;
			})
			.finally(() => retiring.delete(pending));
		retiring.add(pending);
	}

	function reload(next: typeof settings) {
		if (closing) throw new Error("HTTP transport is closed");
		if (current && getGlobalDispatcher() !== current)
			throw new Error("HTTP dispatcher ownership changed; refusing to replace another caller's transport");
		if (!Number.isFinite(next.idleTimeoutMs) || next.idleTimeoutMs < 0)
			throw new Error("Invalid HTTP idle timeout");
		const proxy = next.proxy?.trim() || undefined;
		const dispatcher = listenForClientErrors(
			new EnvHttpProxyAgent({
				httpProxy: process.env.http_proxy ?? process.env.HTTP_PROXY ?? proxy ?? "",
				httpsProxy: process.env.https_proxy ?? process.env.HTTPS_PROXY ?? proxy ?? "",
				noProxy: process.env.no_proxy ?? process.env.NO_PROXY ?? "",
				allowH2: false,
				proxyTunnel: true,
				headersTimeout: Math.floor(next.idleTimeoutMs),
				bodyTimeout: Math.floor(next.idleTimeoutMs),
				connect: { autoSelectFamilyAttemptTimeout: 2000 },
				clientFactory: createClient,
				factory: (origin, options: Pool.Options) =>
					options.connections === 1
						? createClient(origin, options)
						: listenForClientErrors(new Pool(origin, { ...options, factory: createClient })),
			}),
		);
		setGlobalDispatcher(dispatcher);
		const previous = current;
		current = dispatcher;
		if (previous) retire(previous); // close drains active requests; it does not abort them.
	}

	reload(settings);
	processOwned = true;
	// Match fetch and its constructors to the dispatcher, but preserve a deliberate fetch override.
	if (globalThis.fetch === initialFetch) {
		for (const name of fetchGlobals)
			globals.push({ name, previous: Object.getOwnPropertyDescriptor(globalThis, name) });
		install();
		for (const entry of globals) entry.installed = Object.getOwnPropertyDescriptor(globalThis, entry.name);
	}

	return {
		reload,
		close() {
			closing ??= (async () => {
				if (getGlobalDispatcher() === current) setGlobalDispatcher(previousDispatcher);
				for (const entry of globals) {
					if (Object.getOwnPropertyDescriptor(globalThis, entry.name)?.value !== entry.installed?.value)
						continue;
					if (entry.previous) Object.defineProperty(globalThis, entry.name, entry.previous);
					else Reflect.deleteProperty(globalThis, entry.name);
				}
				if (current) retire(current);
				try {
					await Promise.all(retiring);
					if (retirementError) throw new Error("HTTP transport cleanup failed", { cause: retirementError });
				} finally {
					processOwned = false;
				}
			})();
			return closing;
		},
	};
}
