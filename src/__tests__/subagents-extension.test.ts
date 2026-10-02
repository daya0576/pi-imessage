import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type Model, Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	type ExtensionToolContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import {
	HeadlessSubagentResourceLoader,
	type NativeSubagentConfig,
	createHeadlessSubagentsExtension,
	headlessSubagentBridge,
} from "../subagents-extension.js";

const roots: string[] = [];
const temporary = () => {
	const root = mkdtempSync(join(tmpdir(), "native-subagents-"));
	roots.push(root);
	return root;
};
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const textResult = (agentId = "owned") => ({
	content: [{ type: "text" as const, text: "native result" }],
	details: { agentId },
});
const context = { cwd: "/shared", hasUI: false } as ExtensionToolContext;

function harness(execute: ToolDefinition["execute"], config: () => NativeSubagentConfig = () => ({})) {
	let nativeAPI: ExtensionAPI | undefined;
	const handlers = new Map<string, Array<() => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	const sendMessage = vi.fn();
	const nativeShutdown = vi.fn();
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (event: string, handler: () => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	const native: ExtensionFactory = (api) => {
		nativeAPI = api;
		api.on("session_start", () => {
			throw new Error("Native scheduler/RPC must not start");
		});
		api.on("input", () => {
			throw new Error("Mentions must not start detached work");
		});
		api.on("session_shutdown", nativeShutdown);
		for (const name of ["Agent", "SubagentWorkflow", "get_subagent_result", "steer_subagent"])
			api.registerTool({
				name,
				label: name,
				description: "Background by default",
				parameters: Type.Object({}),
				execute,
			});
	};
	createHeadlessSubagentsExtension(pi, native, config, temporary());
	for (const handler of handlers.get("session_start") ?? []) handler();
	const tool = tools.get("Agent");
	if (!tool || !nativeAPI) throw new Error("Native activation failed");
	return { tool, tools, handlers, nativeAPI, nativeShutdown, sendMessage };
}

it("forces native foreground/isolated execution before the runner, drops detached registrations and turns", async () => {
	const execute = vi.fn(async (_id, parameters, _signal, _update, executionContext) => {
		expect(parameters).toMatchObject({ run_in_background: false, isolated: true, isolation: "off" });
		expect(executionContext.cwd).not.toBe(context.cwd);
		return textResult();
	}) as ToolDefinition["execute"];
	const instance = harness(execute);
	expect([...instance.tools.keys()]).toEqual(["Agent"]);
	expect([...instance.handlers.keys()]).toEqual(["session_shutdown", "session_start"]);
	instance.nativeAPI.sendMessage(
		{ customType: "completion", content: "unowned", display: true },
		{ triggerTurn: true }
	);
	instance.nativeAPI.sendUserMessage("unowned");
	expect(instance.sendMessage).not.toHaveBeenCalled();
	await instance.tool.execute(
		"call",
		{ subagent_type: "Explore", run_in_background: true },
		undefined,
		undefined,
		context
	);
	await expect(instance.tool.execute("schedule", { schedule: "5m" }, undefined, undefined, context)).rejects.toThrow(
		"scheduling"
	);
	await expect(instance.tool.execute("foreign", { resume: "foreign" }, undefined, undefined, context)).rejects.toThrow(
		"this chat"
	);
	expect(execute).toHaveBeenCalledTimes(1);
});

it("checks frontmatter AFTER native reload instead of trusting forced parameters", async () => {
	let config: NativeSubagentConfig = {};
	const instance = harness(
		async (_id, parameters) => {
			config = { runInBackground: true }; // native reload happens here
			void (parameters as Record<string, unknown>).subagent_type;
			throw new Error("Unsafe runner was reached");
		},
		() => config
	);
	await expect(
		instance.tool.execute("call", { subagent_type: "pinned-background" }, undefined, undefined, context)
	).rejects.toThrow("overrides headless");
});

it("forwards abort, waits for native settlement, and removes listeners; shutdown retains native cleanup", async () => {
	let settle: (() => void) | undefined;
	let childSignal: AbortSignal | undefined;
	const instance = harness(async (_id, _parameters, signal) => {
		childSignal = signal;
		await new Promise<void>((resolve) => {
			settle = resolve;
		});
		return textResult();
	});
	const controller = new AbortController();
	const removed = vi.spyOn(controller.signal, "removeEventListener");
	const executing = instance.tool.execute("call", {}, controller.signal, undefined, context);
	const rejected = expect(executing).rejects.toThrow("cancel parent");
	await vi.waitFor(() => expect(childSignal).toBeDefined());
	controller.abort(new Error("cancel parent"));
	expect(childSignal?.aborted).toBe(true);
	let finished = false;
	void executing.catch(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	if (!settle) throw new Error("Native execution did not start");
	settle();
	await rejected;
	expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
	for (const handler of instance.handlers.get("session_shutdown") ?? []) await handler();
	expect(instance.nativeShutdown).toHaveBeenCalledOnce();
	await expect(instance.tool.execute("late", {}, undefined, undefined, context)).rejects.toThrow("closed");
});

it("never publishes the native process-global registry or changes an existing CLI manager", () => {
	const key = Symbol.for("pi-subagents:manager");
	const registry = globalThis as unknown as Record<symbol, unknown>;
	const previous = Object.getOwnPropertyDescriptor(registry, key);
	const cli = {};
	Object.defineProperty(registry, key, { configurable: true, writable: true, value: cli });
	try {
		harness(async () => textResult());
		expect(registry[key]).toBe(cli);
	} finally {
		if (previous) Object.defineProperty(registry, key, previous);
		else delete registry[key];
	}
});

it("ignores missing CLI packages without installing them and rejects non-isolated native resource loading", async () => {
	const root = temporary();
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: ["npm:headless-missing-test-package@0.0.0"] }));
	const options = {
		cwd: join(root, "workspace"),
		agentDir: root,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	};
	const loader = new HeadlessSubagentResourceLoader(options);
	await loader.reload();
	expect(loader.getExtensions().extensions).toEqual([]);
	expect(existsSync(join(root, "npm"))).toBe(false);
	expect(() => new HeadlessSubagentResourceLoader({ ...options, noExtensions: false })).toThrow("isolation policy");
});

// This smoke imports the ACTUAL installed source through SDK's isolated jiti
// loader. Portable CI without the optional global package skips it explicitly.
const nativeRoot = join(homedir(), ".pi/agent/npm/node_modules/@tintinweb/pi-subagents/src");
it.skipIf(!existsSync(join(nativeRoot, "index.ts")))(
	"loads the actual native source twice with only Agent and disposes all native timers",
	async () => {
		const root = temporary();
		const intervals = vi.spyOn(globalThis, "setInterval");
		const clearIntervals = vi.spyOn(globalThis, "clearInterval");
		const runtime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: join(root, "models.json"),
			refreshOnCreate: false,
		});
		const model: Model<"openai-responses"> = {
			id: "offline",
			name: "Offline",
			provider: "synthetic",
			api: "openai-responses",
			baseUrl: "https://invalid.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 32000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		runtime.registerProvider("synthetic", {
			api: model.api,
			apiKey: "fake-offline-key",
			baseUrl: model.baseUrl,
			models: [model],
		});
		vi.spyOn(runtime, "streamSimple").mockImplementation((_model, conversation) => {
			const last = conversation.messages.at(-1);
			const content =
				last?.role === "user"
					? typeof last.content === "string"
						? last.content
						: last.content
								.filter((entry) => entry.type === "text")
								.map((entry) => entry.text)
								.join("\n")
					: "offline";
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "text", text: content }],
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		});
		const createChat = async (name: string) => {
			const bridge = join(root, `${name}.ts`);
			writeFileSync(
				bridge,
				headlessSubagentBridge(
					join(nativeRoot, "index.ts"),
					join(process.cwd(), "src/subagents-extension.ts"),
					join(root, name)
				)
			);
			const settingsManager = SettingsManager.inMemory({});
			const loader = new DefaultResourceLoader({
				cwd: join(root, name),
				agentDir: join(root, "agent"),
				settingsManager,
				noExtensions: true,
				additionalExtensionPaths: [bridge],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			const beforeDiscovery = intervals.mock.calls.length;
			await loader.reload();
			expect(intervals.mock.calls.length).toBe(beforeDiscovery);
			expect(loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])).toEqual([]);
			expect(loader.getExtensions().errors).toEqual([]);
			const { session } = await createAgentSession({
				cwd: join(root, name),
				agentDir: join(root, "agent"),
				resourceLoader: loader,
				settingsManager,
				modelRuntime: runtime,
				model,
				sessionManager: SessionManager.inMemory(join(root, name)),
			});
			await session.bindExtensions({});
			expect(intervals.mock.calls.length).toBeGreaterThan(beforeDiscovery);
			session.setActiveToolsByName(["Agent"]);
			return session;
		};
		const first = await createChat("chat-a");
		const second = await createChat("chat-b");
		try {
			const run = async (session: typeof first, prompt: string) => {
				expect(session.getCallableToolNames().filter((name) => /Agent|subagent/.test(name))).toEqual(["Agent"]);
				const tool = session.agent.state.tools.find((tool) => tool.name === "Agent");
				if (!tool) throw new Error("Agent tool was not activated");
				return tool.execute("native-call", {
					subagent_type: "general-purpose",
					prompt,
					description: "offline smoke",
					run_in_background: true,
				});
			};
			const firstResult = await run(first, "chat-a-secret");
			expect(firstResult.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("chat-a-secret") }),
			]);
			const secondResult = await run(second, "chat-b-secret");
			expect(secondResult.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("chat-b-secret") }),
			]);
			expect(JSON.stringify(secondResult)).not.toContain("chat-a-secret");
			const tool = second.agent.state.tools.find((tool) => tool.name === "Agent");
			if (!tool) throw new Error("Agent tool was not activated");
			const foreignId = (firstResult.details as { agentId: string }).agentId;
			expect(foreignId).toBeTruthy();
			await expect(
				tool.execute("foreign", {
					subagent_type: "general-purpose",
					prompt: "noop",
					description: "noop",
					resume: foreignId,
				})
			).rejects.toThrow("this chat");
		} finally {
			for (const session of [first, second]) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			for (const timer of intervals.mock.results.filter((entry) => entry.type === "return").map((entry) => entry.value))
				expect(clearIntervals.mock.calls.some(([cleared]) => cleared === timer)).toBe(true);
		}
	},
	30_000
);
