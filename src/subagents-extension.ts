import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionFactory,
	SettingsManager,
	type ToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

/** These fields come from the native registry, AFTER Agent reloads custom files. */
export interface NativeSubagentConfig {
	runInBackground?: boolean;
	isolated?: boolean;
	isolation?: string;
	sessionDir?: string;
}
export type NativeSubagentLookup = (requested: string) => NativeSubagentConfig | undefined;

const managerKey = Symbol.for("pi-subagents:manager");
const registry = globalThis as unknown as Record<symbol, unknown>;
const disabled = () => {};

/** Native child reload resolves packages even under noExtensions; deny auto-install before entering it. */
export async function assertNativeChildPackagesInstalled(workspace: string, agentDir = getAgentDir()): Promise<void> {
	const settingsManager = SettingsManager.create(workspace, agentDir);
	const packages = new DefaultPackageManager({ cwd: workspace, agentDir, settingsManager });
	const missing: string[] = [];
	await packages.resolve(async (source) => {
		missing.push(source);
		return "skip";
	});
	if (missing.length) throw new Error(`Native child auto-install prevented: ${missing.join(", ")}`);
}

/**
 * Invoke the installed canonical factory, not a replacement agent runner.
 * The bridge must import the factory AND lookup from the same isolated SDK jiti
 * graph (unique loader cwd). Only native Agent is exposed; no RPC, workflows,
 * mentions, scheduler or notification delivery can acquire an unowned turn.
 */
export function createHeadlessSubagentsExtension(
	pi: ExtensionAPI,
	nativeFactory: ExtensionFactory,
	lookupConfig: NativeSubagentLookup,
	sessionDir: string
): void {
	const workspace = join(resolve(sessionDir), "subagents");
	const ownedAgents = new Set<string>();
	const controllers = new Set<AbortController>();
	const settlements = new Set<Promise<unknown>>();
	let closed = false;
	let activated = false;

	pi.on("session_shutdown", async () => {
		closed = true;
		for (const controller of controllers) controller.abort(new Error("Subagent session shut down"));
		// Do NOT race cancellation against execution: the parent retains ownership
		// until the native runner has finished cancelling and settled its work.
		await Promise.allSettled([...settlements]);
	});

	const adapt = (tool: ToolDefinition): ToolDefinition => ({
		...tool,
		exposure: "deferred",
		description:
			"Run a native subagent synchronously in this chat's private workspace. Returns its final result inline. " +
			"No background execution, schedules, nested extension tools or completion follow-up turns are supported.",
		promptGuidelines: ["Subagents block and return their result inline; never expect a later completion notification."],
		async execute(id, parameters, signal, onUpdate, context) {
			if (closed) throw new Error("Subagent session is closed");
			signal?.throwIfAborted();
			const input: Record<string, unknown> = {
				...(parameters as Record<string, unknown>),
				run_in_background: false,
				isolated: true,
				isolation: "off",
			};
			if (input.schedule) throw new Error("Subagent scheduling is disabled; use the service scheduler");
			if (input.resume && (typeof input.resume !== "string" || !ownedAgents.has(input.resume)))
				throw new Error("Subagent resume ID does not belong to this chat");
			const requested = typeof input.subagent_type === "string" ? input.subagent_type : "";
			// Native Agent reloads its registry immediately before reading this
			// field. Validate THERE: frontmatter outranks run_in_background and
			// isolated parameters, so a preflight before execute is insufficient.
			Object.defineProperty(input, "subagent_type", {
				enumerable: true,
				get() {
					const config = lookupConfig(requested);
					if (!config) throw new Error("Native subagent type cannot be safely resolved");
					if (
						config.runInBackground === true ||
						config.isolated === false ||
						config.isolation === "worktree" ||
						config.sessionDir
					)
						throw new Error("Native subagent configuration overrides headless ownership/isolation policy");
					return requested;
				},
			});
			const controller = new AbortController();
			const forwardAbort = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", forwardAbort, { once: true });
			controllers.add(controller);
			const execution = Promise.resolve().then(async () => {
				controller.signal.throwIfAborted();
				await assertNativeChildPackagesInstalled(workspace);
				controller.signal.throwIfAborted();
				return tool.execute(id, input, controller.signal, onUpdate, { ...context, cwd: workspace, hasUI: false });
			});
			settlements.add(execution);
			try {
				const result = await execution;
				controller.signal.throwIfAborted();
				const details = result.details as { agentId?: unknown } | undefined;
				if (typeof details?.agentId === "string") ownedAgents.add(details.agentId);
				return result;
			} finally {
				signal?.removeEventListener("abort", forwardAbort);
				controllers.delete(controller);
				settlements.delete(execution);
			}
		},
	});
	const proxy = new Proxy(pi, {
		get(target, property) {
			if (property === "registerTool")
				return (tool: ToolDefinition) => {
					if (tool.name === "Agent") target.registerTool(adapt(tool));
				};
			if (property === "on")
				return (event: string, handler: (...argumentsList: unknown[]) => unknown) => {
					// Native shutdown owns manager cleanup interval, child disposal and
					// pending notification timers. Never discard this lifecycle handler.
					if (event === "session_shutdown") return Reflect.apply(target.on, target, [event, handler]);
					return disabled;
				};
			if (
				[
					"sendMessage",
					"sendUserMessage",
					"registerCommand",
					"registerShortcut",
					"registerFlag",
					"registerMessageRenderer",
					"registerEntryRenderer",
					"setActiveTools",
				].includes(String(property))
			)
				return disabled;
			if (property === "getFlag") return () => undefined;
			// Keep cross-extension RPC entirely disconnected, even from other
			// extensions bound to this chat. Agent's native execution uses no RPC.
			if (property === "events") return { on: () => disabled, emit: disabled };
			if (property === "exec")
				return (...argumentsList: Parameters<ExtensionAPI["exec"]>) => {
					const [command, arguments_] = argumentsList;
					// Native dispose() prunes process.cwd(), not the private workspace.
					if (command === "git" && arguments_[0] === "worktree")
						return Promise.resolve({ stdout: "", stderr: "Headless worktrees disabled", code: 1, killed: false });
					return target.exec(...argumentsList);
				};
			return Reflect.get(target, property);
		},
	});
	// Native factory advertises a process-global manager even without RPC.
	// Occupy its slot only during synchronous activation, preserving any real
	// CLI manager. The headless manager must never become process-discoverable.
	pi.on("session_start", () => {
		if (closed || activated) return;
		activated = true;
		mkdirSync(workspace, { recursive: true, mode: 0o700 });
		const previous = Object.getOwnPropertyDescriptor(registry, managerKey);
		Object.defineProperty(registry, managerKey, { configurable: true, writable: true, value: {} });
		try {
			const result = nativeFactory(proxy);
			if (result && typeof result.then === "function")
				throw new Error("Headless native factory must activate synchronously");
		} finally {
			if (previous) Object.defineProperty(registry, managerKey, previous);
			else delete registry[managerKey];
		}
	});
}
