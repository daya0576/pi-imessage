import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionToolContext,
	ModelRuntime,
	type ResolvedResource,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	createAgentSession,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	adaptHeadlessTool,
	createHeadlessExtensionAPI,
	createHeadlessResourceLoader,
	createHeadlessSchedulerExtension,
	isSelfRemoteTarget,
	isolatedRemoteSession,
	reviewedExtensionKind,
} from "../headless-extensions.js";
import { createSchedulerService } from "../scheduler.js";

let root: string;
let agentDir: string;
const put = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
};
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "headless-extensions-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const extensionImports = `import { Type } from "typebox";`;
function configure() {
	put(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: ["!extensions/**", "+extensions/openai-codex-fast.ts", "+extensions/unreviewed.ts"],
			packages: ["npm:pi-web-access@0.35.0", "npm:pi-browser-actions@1.1.1"],
			defaultTools: ["+tool_search", "+codemode"],
		})
	);
	put(
		join(agentDir, "extensions/openai-codex-fast.ts"),
		`export default function(pi) {
		pi.on("before_provider_request", (event, ctx) => ctx.model?.provider === "openai-codex" && /^gpt-/.test(ctx.model.id) ? {...event.payload, service_tier:"priority"} : undefined);
	}`
	);
	put(join(agentDir, "extensions/unreviewed.ts"), `throw new Error("unreviewed factory was imported");`);
	for (const [name, version] of [
		["pi-web-access", "0.35.0"],
		["pi-browser-actions", "1.1.1"],
	]) {
		put(
			join(agentDir, "npm/node_modules", name, "package.json"),
			JSON.stringify({
				name,
				version,
				type: "module",
				pi: { extensions: ["index.ts"] },
			})
		);
	}
	put(
		join(agentDir, "npm/node_modules/pi-web-access/index.ts"),
		`${extensionImports}
		let calls = 0;
		export default function(pi) {
			pi.on("session_shutdown", () => { calls = 0; });
		pi.registerTool({name:"web_search",label:"Search",description:"Search",parameters:Type.Object({workflow:Type.Optional(Type.String()),includeContent:Type.Optional(Type.Boolean())}),
			async execute(_id, params) {pi.appendEntry("web-search-results", {id:"response-" + (++calls)});return {content:[{type:"text",text:JSON.stringify({...params,calls})}],details:{}};}});
			pi.registerTool({name:"get_search_content",label:"Cached",description:"Shared disk cache",parameters:Type.Object({responseId:Type.String()}),async execute(){return {content:[{type:"text",text:"cached"}],details:{}};}});
			pi.registerCommand("curator",{handler(){throw new Error("TUI command called")}});
		}
	`
	);
	put(
		join(agentDir, "npm/node_modules/pi-browser-actions/index.ts"),
		`${extensionImports}
		export default function(pi) {
			for(const name of ["browser_session","browser","web_search","web_fetch"])
				pi.registerTool({name,label:name,description:name,parameters:Type.Object({action:Type.Optional(Type.String()),headed:Type.Optional(Type.Boolean())}),
				async execute(_id,params){return {content:[{type:"text",text:JSON.stringify(params)}],details:{}};}});
			pi.on("session_start",()=>pi.setActiveTools(pi.getActiveTools().filter(name=>name!=="browser")));
		}
	`
	);
	for (const name of ["browser", "search", "brave-search", "browser-task"])
		put(
			join(agentDir, "skills", name, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${name} domain instructions\n---\nInstructions`
		);
}
function loader(readOnly = false, sessionKey = "chat-a") {
	const sessionDir = join(root, sessionKey);
	mkdirSync(sessionDir, { recursive: true });
	const settingsManager = SettingsManager.create(root, agentDir);
	return {
		settingsManager,
		resourceLoader: createHeadlessResourceLoader({
			cwd: root,
			agentDir,
			sessionDir,
			settingsManager,
			readOnly,
			systemPrompt: "Test",
			log: () => {},
		}),
	};
}
const context = {} as ExtensionToolContext;

it("filters disabled/unreviewed/project sources using provenance before import", () => {
	const resource: ResolvedResource = {
		path: join(agentDir, "extensions/openai-codex-fast.ts"),
		enabled: true,
		metadata: { scope: "user", source: "local", origin: "top-level" },
	};
	expect(reviewedExtensionKind(resource, agentDir)).toBe("openai-codex-fast");
	expect(reviewedExtensionKind({ ...resource, enabled: false }, agentDir)).toBeUndefined();
	expect(
		reviewedExtensionKind({ ...resource, metadata: { ...resource.metadata, scope: "project" } }, agentDir)
	).toBeUndefined();
	expect(reviewedExtensionKind({ ...resource, path: join(root, "openai-codex-fast.ts") }, agentDir)).toBeUndefined();
});

it("loads the shared provider hook once, rejects unknown imports, filters browser duplicate tools before registration", async () => {
	configure();
	const { resourceLoader, settingsManager } = loader();
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const extensions = resourceLoader.getExtensions().extensions;
	expect(extensions.filter((extension) => extension.path.endsWith("openai-codex-fast.ts"))).toHaveLength(1);
	const browser = extensions.find((extension) => extension.path.includes("pi-browser-actions"));
	expect([...(browser?.tools.keys() ?? [])]).toEqual(["browser_session", "browser"]);
	expect(extensions.flatMap((extension) => [...extension.commands.keys()])).toEqual([]);
	expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["browser-task"]);
	expect(settingsManager.getDefaultTools()).toEqual(["read", "bash", "edit", "write", "tool_search"]);
	expect(resourceLoader.getHeadlessAudit().loaded).toEqual([
		"openai-codex-fast",
		"pi-web-access",
		"pi-browser-actions",
	]);
	const fast = extensions.find((extension) => extension.path.endsWith("openai-codex-fast.ts"));
	const handlers = fast?.handlers.get("before_provider_request") ?? [];
	expect(handlers).toHaveLength(1);
	expect(
		await handlers[0]({ payload: { input: "hello" } }, { model: { provider: "openai-codex", id: "gpt-6.1-sol" } })
	).toEqual({ input: "hello", service_tier: "priority" });
});

it("isolates two real SDK chat sessions and forces noninteractive raw search", async () => {
	configure();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
	});
	const createChat = async (key: string) => {
		const { resourceLoader, settingsManager } = loader(false, key);
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(root),
		});
		await session.bindExtensions({});
		return session;
	};
	const first = await createChat("chat-a");
	const second = await createChat("chat-b");
	const execute = async (session: typeof first) => {
		const search = session.agent.state.tools.find((tool) => tool.name === "web_search");
		if (!search) throw new Error("web_search missing");
		const result = await search.execute("search", { workflow: "summary-review", includeContent: true });
		return JSON.parse((result.content[0] as { text: string }).text);
	};
	try {
		expect(await execute(first)).toEqual({ workflow: "none", includeContent: false, calls: 1 });
		expect(await execute(second)).toEqual({ workflow: "none", includeContent: false, calls: 1 });
		expect(await execute(first)).toEqual({ workflow: "none", includeContent: false, calls: 2 });
		const cached = second.agent.state.tools.find((tool) => tool.name === "get_search_content");
		if (!cached) throw new Error("get_search_content missing");
		await expect(cached.execute("cached", { responseId: "response-2" })).rejects.toThrow(
			"does not belong to this session"
		);
		expect((await cached.execute("cached", { responseId: "response-1" })).content).toEqual([
			{ type: "text", text: "cached" },
		]);
		await first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(await execute(second)).toEqual({ workflow: "none", includeContent: false, calls: 2 });
	} finally {
		first.dispose();
		await second.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		second.dispose();
	}
});

it("never loads writable/browser/remote factories or skills for read-only summaries", async () => {
	configure();
	const { resourceLoader, settingsManager } = loader(true);
	await resourceLoader.reload();
	expect(resourceLoader.getHeadlessAudit().loaded).toEqual(["openai-codex-fast"]);
	expect(resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])).toEqual([]);
	expect(resourceLoader.getSkills().skills).toEqual([]);
	expect(settingsManager.getDefaultTools()).toEqual(["read"]);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
	});
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		tools: ["read"],
	});
	try {
		await session.bindExtensions({});
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getCallableToolNames()).toEqual(["read"]);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});

it("honors shared disables on reload and keeps legacy domain instructions until tools actually load", async () => {
	configure();
	const { resourceLoader } = loader();
	await resourceLoader.reload();
	put(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [{ source: "npm:pi-browser-actions@1.1.1", extensions: [] }] })
	);
	await resourceLoader.reload();
	expect(resourceLoader.getHeadlessAudit().loaded).toEqual(["openai-codex-fast"]);
	expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual([
		"brave-search",
		"browser",
		"browser-task",
		"search",
	]);
});

it("loads browser-actions through the shared adapter once, dropping its search alias", async () => {
	configure();
	put(
		join(agentDir, "extensions/browser-actions/index.ts"),
		`import factory from "../../npm/node_modules/pi-browser-actions/index.ts";
		export default (pi) => factory({...pi, registerTool: (tool) => pi.registerTool(tool.name === "web_search" ? {...tool, name: "browser_web_search"} : tool)});`
	);
	put(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: ["!extensions/**", "+extensions/browser-actions/index.ts"],
			packages: ["npm:pi-browser-actions@1.1.1"],
		})
	);
	const { resourceLoader } = loader();
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	expect(resourceLoader.getHeadlessAudit().loaded).toEqual(["pi-browser-actions"]);
	expect(resourceLoader.getHeadlessAudit().skipped).toEqual(
		expect.arrayContaining([expect.objectContaining({ reason: "duplicate pi-browser-actions source; loaded once" })])
	);
	const browser = resourceLoader
		.getExtensions()
		.extensions.filter((extension) => extension.path.includes("browser-actions"));
	expect(browser.flatMap((extension) => [...extension.tools.keys()])).toEqual(["browser_session", "browser"]);
});

it("starts writable isolated cron sessions with builtins and headless tools after SDK reload", async () => {
	configure();
	const { resourceLoader, settingsManager } = loader(false, "task/chat-a/daily");
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: join(root, "models.json"),
	});
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
	});
	try {
		await session.bindExtensions({});
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "browser_session"])
		);
		expect(session.getAllTools().filter((tool) => tool.name === "web_search")).toHaveLength(1);
		await session.reload();
		expect(readdirSync(join(root, "task/chat-a/daily")).filter((name) => name.startsWith(".headless-"))).toHaveLength(
			1
		);
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "browser_session"])
		);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		expect(readdirSync(join(root, "task/chat-a/daily")).filter((name) => name.startsWith(".headless-"))).toEqual([]);
	}
});

it("adapts canonical scheduler tools to durable chat-owned service tasks without terminal lifecycle hooks", async () => {
	const scheduler = createSchedulerService({ workingDir: root, deliver: async () => {} });
	const toolsFor = async (owner: string) => {
		const tools = new Map<string, ToolDefinition>();
		const on = vi.fn();
		const registerCommand = vi.fn();
		const pi = {
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			on,
			registerCommand,
		} as unknown as ExtensionAPI;
		await createHeadlessSchedulerExtension(scheduler, owner)(pi);
		expect(registerCommand).not.toHaveBeenCalled();
		expect(on.mock.calls.map((call) => call[0])).toEqual(["before_agent_start"]);
		return async (name: string, id: string, input: unknown) => {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Missing scheduler tool ${name}`);
			return tool.execute(id, input, undefined, undefined, context);
		};
	};
	try {
		const first = await toolsFor("chat-a");
		const second = await toolsFor("chat-b");
		const created = await first("schedule_task", "same-call", { when: "1h", prompt: "Review" });
		const repeated = await first("schedule_task", "same-call", { when: "1h", prompt: "Review" });
		expect(repeated.details).toEqual(created.details);
		const taskId = (created.details as { id: string }).id;
		await expect(second("cancel_scheduled_task", "cancel", { id: taskId })).rejects.toThrow("this chat");
		expect((await second("list_scheduled_tasks", "list", {})).details).toEqual({ tasks: [] });
		await first("loop_task", "loop", { interval: "5m", prompt: "Repeat until tests pass" });
		expect(scheduler.list("chat-a").map((task) => task.intervalMs)).toEqual(expect.arrayContaining([null, 300000]));
		await first("cancel_scheduled_task", "cancel", { id: taskId });
	} finally {
		await scheduler.stop();
	}
});

describe("headless runtime guards", () => {
	it("prevents browser attachment/shared discovery and headed launch before executing", async () => {
		const execute = vi.fn(async (_id, input) => ({
			content: [{ type: "text" as const, text: JSON.stringify(input) }],
			details: {},
		}));
		const tool = adaptHeadlessTool(
			defineTool({
				name: "browser_session",
				label: "Browser",
				description: "Browser",
				parameters: Type.Object({ action: Type.String(), headed: Type.Optional(Type.Boolean()) }),
				execute,
			}),
			"pi-browser-actions",
			"/chat-a"
		);
		await expect(tool.execute("x", { action: "attach" }, undefined, undefined, context)).rejects.toThrow("attachment");
		await expect(tool.execute("x", { action: "list_sessions" }, undefined, undefined, context)).rejects.toThrow(
			"discovery"
		);
		await expect(tool.execute("x", { action: "open", headed: true }, undefined, undefined, context)).rejects.toThrow(
			"headless"
		);
		expect(execute).not.toHaveBeenCalled();
		await tool.execute("x", { action: "open" }, undefined, undefined, context);
		expect(execute.mock.calls[0][1]).toEqual({ action: "open", headed: false });
	});

	it("namespaces remote calls by chat/task and rejects self-targets before refresh and execution", async () => {
		expect(isSelfRemoteTarget("http://10.200.1.245:7750", ["clawbots-mini.local"])).toBe(true);
		expect(isSelfRemoteTarget("http://10.200.1.245:7750", ["mini", "10.200.1.23"])).toBe(false);
		expect(isolatedRemoteSession("/chat-a", "default")).not.toBe(isolatedRemoteSession("/chat-b", "default"));
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
		const tool = adaptHeadlessTool(
			defineTool({
				name: "claw_agent",
				label: "Remote",
				description: "Remote",
				parameters: Type.Object({ task: Type.String(), session: Type.Optional(Type.String()) }),
				execute,
			}),
			"claw-remote",
			"/chat-a",
			() => true
		);
		await expect(tool.execute("x", { task: "hello" }, undefined, undefined, context)).rejects.toThrow(
			"Self-delegation"
		);
		expect(execute).not.toHaveBeenCalled();
		const handlers: ((...values: unknown[]) => unknown)[] = [];
		const pi = {
			on: (_event: string, handler: (...values: unknown[]) => unknown) => {
				handlers.push(handler);
			},
		} as unknown as ExtensionAPI;
		const callback = vi.fn();
		createHeadlessExtensionAPI(pi, "claw-remote", "/chat-a").on("session_start", callback);
		vi.stubEnv("CLAW_REMOTE_URL", "http://localhost:7750");
		handlers[0]({}, context);
		expect(callback).not.toHaveBeenCalled();
		put(join(agentDir, "extensions/claw-remote.ts"), `throw new Error("self remote module was imported");`);
		put(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["+extensions/claw-remote.ts"] }));
		const { resourceLoader } = loader();
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		expect(resourceLoader.getHeadlessAudit().skipped).toEqual(
			expect.arrayContaining([{ path: join(agentDir, "extensions/claw-remote.ts"), reason: "self-delegation" }])
		);
	});
});
