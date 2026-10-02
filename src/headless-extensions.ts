import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type InlineExtension,
	type LoadExtensionsResult,
	type ResolvedResource,
	SettingsManager,
	type ToolDefinition,
	createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
import { type SchedulerService, parseSchedulerInterval, parseSchedulerTime } from "./scheduler.js";
import sharedSchedulerFactory from "./shared-scheduler/index.js";

export const HEADLESS_BUILTIN_TOOLS = ["read", "bash", "edit", "write"];
type ExtensionKind =
	| "openai-codex-fast"
	| "claw-remote"
	| "pi-web-access"
	| "pi-browser-actions"
	| "pi-subagents"
	| "pi-goal-x";
const REVIEWED_PACKAGES = new Map<string, ExtensionKind>([
	["pi-web-access", "pi-web-access"],
	["pi-browser-actions", "pi-browser-actions"],
	["@tintinweb/pi-subagents", "pi-subagents"],
	["pi-goal-x", "pi-goal-x"],
]);
const GOAL_HOST_CHANNEL = "pi-imessage:goal-host";
export type GoalCheckpointMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/** Normal writable chats only: the host's per-chat queue owns every goal turn. */
export interface HeadlessGoalHost {
	/** Per-chat goal pool, never the shared workspace `.pi/goals`. */
	storageRoot: string;
	/** True while this session is not the chat's idle current session. */
	busy(): boolean;
	/** Queue a claimed checkpoint turn behind input already accepted for this chat. */
	continue(message: GoalCheckpointMessage): void;
}
// The browser-actions adapter loads the installed npm package; its search alias is dropped headless.
const REVIEWED_LOCAL_FILES = new Map<string, ExtensionKind>([
	["openai-codex-fast.ts", "openai-codex-fast"],
	["claw-remote.ts", "claw-remote"],
	["browser-actions/index.ts", "pi-browser-actions"],
]);

export interface HeadlessExtensionAudit {
	loaded: string[];
	skipped: { path: string; reason: string }[];
}
export type HeadlessResourceLoader = DefaultResourceLoader & {
	getHeadlessAudit(): HeadlessExtensionAudit;
	disposeArtifacts(): void;
};

export interface HeadlessExtensionsOptions {
	cwd: string;
	agentDir: string;
	/** A unique storage directory, including isolated task keys, never the shared workspace. */
	sessionDir: string;
	settingsManager: SettingsManager;
	systemPrompt: string;
	readOnly?: boolean;
	extensionFactories?: InlineExtension[];
	/** Enables pi-goal-x; omitted for isolated, read-only and cron sessions. */
	goal?: HeadlessGoalHost;
	log?: (message: string) => void;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function npmPackageName(source: string): string | undefined {
	return /^npm:([^@][^@]*|@[^/]+\/[^@]+)(?:@[^\s]+)?$/.exec(source)?.[1];
}

/** Provenance and enabled state are checked BEFORE importing any extension code. */
export function reviewedExtensionKind(resource: ResolvedResource, agentDir: string): ExtensionKind | undefined {
	if (!resource.enabled || resource.metadata.scope !== "user") return;
	if (resource.metadata.origin === "package") {
		const kind = REVIEWED_PACKAGES.get(npmPackageName(resource.metadata.source) ?? "");
		const root = resource.metadata.packageRoot;
		if (!kind || !root) return;
		const pathWithinPackage = relative(canonicalPath(root), canonicalPath(resource.path));
		if (pathWithinPackage === "" || pathWithinPackage.startsWith("..") || isAbsolute(pathWithinPackage)) return;
		return kind;
	}
	for (const [file, kind] of REVIEWED_LOCAL_FILES) {
		if (canonicalPath(resource.path) === canonicalPath(join(agentDir, "extensions", file))) return kind;
	}
}

/** Deny the claw endpoint when it names this host; invalid targets fail closed. */
export function isSelfRemoteTarget(
	url = process.env.CLAW_REMOTE_URL ?? "http://10.200.1.245:7750",
	hosts = [
		hostname(),
		...Object.values(networkInterfaces()).flatMap((entries) => entries?.map((entry) => entry.address) ?? []),
	]
): boolean {
	try {
		const target = new URL(url);
		if (!["http:", "https:"].includes(target.protocol)) return true;
		const normalize = (host: string) =>
			host
				.toLowerCase()
				.replace(/^\[|\]$/g, "")
				.replace(/\.$/, "");
		const destination = normalize(target.hostname);
		const normalizedHosts = hosts.map(normalize);
		const clawHost = normalizedHosts.some((host) => /^(claw|clawbot|clawbots-mini)(?:\.|$)/.test(host));
		return (
			["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(destination) ||
			normalizedHosts.some((host) => destination === host || destination === `${host}.local`) ||
			(clawHost && ["claw", "claw.local", "clawbots-mini", "clawbots-mini.local", "10.200.1.245"].includes(destination))
		);
	} catch {
		return true;
	}
}

export function isolatedRemoteSession(sessionDir: string, requested = "default"): string {
	const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
	return `imessage_${digest(resolve(sessionDir))}_${digest(requested)}`;
}

/** Adapt reviewed tools without changing the shared installation or process environment. */
export function adaptHeadlessTool(
	tool: ToolDefinition,
	kind: ExtensionKind,
	sessionDir: string,
	selfRemote: () => boolean = isSelfRemoteTarget
): ToolDefinition {
	const execute = tool.execute;
	return {
		...tool,
		...(kind === "pi-browser-actions"
			? {
					description: `${tool.description} This service only permits private headless sessions; attachment and session discovery are disabled.`,
					promptGuidelines: [
						"Use browser_session action=open for this chat's private headless browser; close it when done. Never attach to another session.",
					],
				}
			: {}),
		async execute(id, parameters, signal, onUpdate, context) {
			const input: Record<string, unknown> =
				typeof parameters === "object" && parameters !== null ? { ...parameters } : {};
			const properties = "properties" in tool.parameters ? (tool.parameters.properties as Record<string, unknown>) : {};
			if (kind === "pi-browser-actions") {
				if (input.action === "attach" || input.action === "list_sessions")
					throw new Error("Browser attachment and session discovery are disabled in headless chat sessions");
				if (input.action === "open") {
					if (input.headed === true) throw new Error("Only headless browsers are supported by pi-imessage");
					input.headed = false;
				}
			}
			if (kind === "pi-web-access") {
				// The shared package's disk cache is global. Only response IDs recorded
				// on this session's active branch may be retrieved, including after reload.
				if ("responseId" in properties && typeof input.responseId === "string") {
					const owned = context.sessionManager.getBranch().some((entry) => {
						if (entry.type !== "custom" || entry.customType !== "web-search-results") return false;
						return (
							typeof entry.data === "object" &&
							entry.data !== null &&
							"id" in entry.data &&
							entry.data.id === input.responseId
						);
					});
					if (!owned) throw new Error("Search responseId does not belong to this session");
				}
				// Force raw search even when shared config or the model requests curator UI/summary work.
				if ("workflow" in properties) input.workflow = "none";
				// Background follow-up turns bypass the host queue; fetch content explicitly instead.
				if ("includeContent" in properties) input.includeContent = false;
			}
			if (kind === "claw-remote") {
				if (selfRemote()) throw new Error("Self-delegation to claw is disabled on this host");
				input.session = isolatedRemoteSession(
					sessionDir,
					typeof input.session === "string" ? input.session : "default"
				);
			}
			return execute(id, input, signal, onUpdate, context);
		},
	};
}

/**
 * pi-goal-x keeps its own durable state machine. The service relocates its pool per
 * chat, reports host-queued work as pending input so it claims a checkpoint only
 * when the chat is idle, and runs that checkpoint as a queued host turn.
 */
function createGoalExtensionAPI(pi: ExtensionAPI): ExtensionAPI {
	// Bridges load in a separate module graph; the per-session event bus reaches the host.
	const host = (): HeadlessGoalHost => {
		const request: { host?: HeadlessGoalHost } = {};
		pi.events.emit(GOAL_HOST_CHANNEL, request);
		if (!request.host) throw new Error("pi-goal-x is not bound to a writable chat session");
		return request.host;
	};
	const context = (ctx: unknown) =>
		typeof ctx === "object" && ctx !== null
			? new Proxy(ctx as ExtensionContext, {
					get(target, property) {
						if (property === "goalStorageRoot") return host().storageRoot;
						if (property === "hasPendingMessages") return () => target.hasPendingMessages() || host().busy();
						return Reflect.get(target, property);
					},
				})
			: ctx;
	return new Proxy(pi, {
		get(target, property) {
			if (property === "sendMessage")
				return (message: GoalCheckpointMessage, options?: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
					if (options?.triggerTurn) host().continue(message);
					else target.sendMessage(message, options);
				};
			// Only interactive /goal drafting sends user turns; never start an unowned run.
			if (property === "sendUserMessage")
				return () => {
					throw new Error("Goal drafting is unavailable in headless chat sessions");
				};
			if (property === "registerCommand")
				return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
					if (!/^goal-(status|pause|resume|clear|list|focus|unfocus|direct)$/.test(name)) return;
					target.registerCommand(name, {
						...command,
						handler: (args, ctx) => command.handler(args, context(ctx) as typeof ctx),
					});
				};
			if (property === "on")
				return new Proxy(target.on, {
					apply(on, receiver, argumentsList) {
						const [event, handler] = argumentsList as [string, (payload: unknown, ctx: unknown) => unknown];
						return Reflect.apply(on, receiver, [
							event,
							(payload: unknown, ctx: unknown) => handler(payload, context(ctx)),
						]);
					},
				});
			if (property === "registerTool")
				return (tool: ToolDefinition) =>
					target.registerTool({
						...tool,
						execute: (id, parameters, signal, onUpdate, ctx) =>
							tool.execute(id, parameters, signal, onUpdate, context(ctx) as typeof ctx),
					});
			return Reflect.get(target, property);
		},
	});
}

/** The canonical factory gets this proxy before it can register conflicting tools. */
export function createHeadlessExtensionAPI(pi: ExtensionAPI, kind: ExtensionKind, sessionDir: string): ExtensionAPI {
	return new Proxy(kind === "pi-goal-x" ? createGoalExtensionAPI(pi) : pi, {
		get(target, property) {
			if (property === "registerShortcut" || (property === "registerCommand" && kind !== "pi-goal-x")) return () => {};
			if (property === "registerTool")
				return (tool: ToolDefinition) => {
					if (kind === "pi-browser-actions" && !["browser", "browser_session"].includes(tool.name)) return;
					target.registerTool(adaptHeadlessTool(tool, kind, sessionDir));
				};
			if (property === "on" && kind === "claw-remote")
				return new Proxy(target.on, {
					apply(on, receiver, argumentsList) {
						const [event, handler] = argumentsList as [string, (...values: unknown[]) => unknown];
						return Reflect.apply(on, receiver, [
							event,
							(...values: unknown[]) => {
								if (!isSelfRemoteTarget()) return handler(...values);
							},
						]);
					},
				});
			return Reflect.get(target, property);
		},
	});
}

/** Canonical shared tools, but only the service owns persistence, timers and delivery. */
export function createHeadlessSchedulerExtension(scheduler: SchedulerService, chatGuid: string): ExtensionFactory {
	return (pi) => {
		const adapt = (tool: ToolDefinition): ToolDefinition => ({
			...tool,
			description: `${tool.description} In pi-imessage these tasks belong to the current chat and the service, and survive session reload/reset and service restart.`,
			async execute(toolCallId, parameters) {
				const input = parameters as { when: string; prompt: string; id: string; interval: string };
				let result: unknown;
				// Relative times must not drift when the same model tool call is retried.
				const existing = scheduler.list(chatGuid).find((task) => task.idempotencyKey === toolCallId);
				if (existing && ["schedule_task", "loop_task"].includes(tool.name)) {
					const intervalMs = tool.name === "loop_task" ? parseSchedulerInterval(input.interval) : null;
					if (existing.prompt !== input.prompt.trim() || existing.intervalMs !== intervalMs)
						throw new Error("Scheduler tool call already has different task data");
					return { content: [{ type: "text", text: JSON.stringify(existing) }], details: existing };
				}
				if (tool.name === "schedule_task") {
					result = scheduler.schedule({
						owner: chatGuid,
						prompt: input.prompt,
						fireAt: parseSchedulerTime(input.when),
						idempotencyKey: toolCallId,
					});
				} else if (tool.name === "loop_task") {
					const intervalMs = parseSchedulerInterval(input.interval);
					if (intervalMs === null || intervalMs <= 0) throw new Error("Loop interval must be a positive duration");
					result = scheduler.schedule({
						owner: chatGuid,
						prompt: input.prompt,
						fireAt: Date.now(),
						intervalMs,
						idempotencyKey: toolCallId,
					});
				} else if (tool.name === "cancel_scheduled_task") {
					result = scheduler.cancel(input.id, chatGuid);
					if (!result) throw new Error("Scheduled task not found in this chat");
				} else {
					result = { tasks: scheduler.list(chatGuid) };
				}
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
		let scheduleTool: ToolDefinition | undefined;
		sharedSchedulerFactory(
			new Proxy(pi, {
				get(target, property) {
					if (["on", "registerCommand", "registerShortcut"].includes(String(property))) return () => () => {};
					if (property === "registerTool")
						return (tool: ToolDefinition) => {
							if (tool.name === "schedule_task") scheduleTool = tool;
							target.registerTool(adapt(tool));
						};
					return Reflect.get(target, property);
				},
			})
		);
		if (scheduleTool)
			pi.registerTool(
				adapt({
					...scheduleTool,
					name: "loop_task",
					label: "Loop Task",
					description:
						"Run a prompt now, then repeat at the given interval until cancelled or its explicit stop condition is satisfied.",
					parameters: Type.Object({
						interval: Type.String({ description: "Positive repeat duration, e.g. 30s, 5m, 1h" }),
						prompt: Type.String(),
					}),
				})
			);
		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.sections.scheduler =
				"Use schedule_task, loop_task, list_scheduled_tasks and cancel_scheduled_task for durable delayed/repeating prompts in this chat. Load them with tool_search first. The service owns timers and delivery; tasks survive session reload/reset and service restart. Cancel a loop when its explicit stop condition is met.";
		});
	};
}

/**
 * SDK discovery honors packages/extension selectors but imports no factories.
 * The actual loader sees only reviewed paths, and empty package settings prevent
 * reload() from auto-installing missing/unreviewed packages and their scripts.
 */
export function createHeadlessResourceLoader(options: HeadlessExtensionsOptions): HeadlessResourceLoader {
	const log = options.log ?? console.log;
	const audit: HeadlessExtensionAudit = { loaded: [], skipped: [] };
	const extensionPaths: string[] = [];
	const skillPaths: string[] = [];
	const resourcesByBridge = new Map<string, { kind: ExtensionKind; resource: ResolvedResource }>();
	const wrapperDir = join(options.sessionDir, `.headless-${randomUUID()}`);
	const disposeArtifacts = () => rmSync(wrapperDir, { recursive: true, force: true });
	const discoverySettings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const packageManager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: discoverySettings,
	});
	const safeSettings = SettingsManager.inMemory({}, { projectTrusted: false });
	const loader: DefaultResourceLoader = new DefaultResourceLoader({
		// A distinct module-cache key per loader prevents packages with module-level
		// state (pi-web-access) from sharing responses/controllers across chats.
		cwd: wrapperDir,
		agentDir: options.agentDir,
		settingsManager: safeSettings,
		systemPrompt: options.systemPrompt,
		additionalExtensionPaths: extensionPaths,
		additionalSkillPaths: skillPaths,
		extensionFactories: [
			...(options.extensionFactories ?? []),
			{
				name: "headless-cleanup",
				factory: (pi) => {
					pi.on("session_shutdown", disposeArtifacts);
				},
			},
			...(!options.readOnly ? [{ name: "headless-tool-search", factory: createToolSearchExtension() }] : []),
			...(options.goal
				? [
						{
							name: "headless-goal-host",
							factory: (pi: ExtensionAPI) => {
								pi.events.on(GOAL_HOST_CHANNEL, (request) => {
									(request as { host?: HeadlessGoalHost }).host = options.goal;
								});
							},
						},
					]
				: []),
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: Boolean(options.readOnly),
		appendSystemPrompt: [],
		extensionsOverride: (result: LoadExtensionsResult) => {
			for (const extension of result.extensions) {
				const selected = resourcesByBridge.get(canonicalPath(extension.path));
				if (!selected) continue;
				// Restore original provenance: the wrapper is not an independent extension.
				extension.path = selected.resource.path;
				extension.resolvedPath = canonicalPath(selected.resource.path);
			}
			// Source metadata is restored after SDK reload assigns its CLI provenance.
			return result;
		},
		skillsOverride: (result) => {
			const loaded = new Set(
				loader
					.getExtensions()
					.extensions.map(
						(extension) =>
							[...resourcesByBridge.values()].find(
								(selected) => canonicalPath(selected.resource.path) === canonicalPath(extension.path)
							)?.kind
					)
			);
			return {
				...result,
				skills: result.skills.filter((skill) => {
					if (loaded.has("pi-web-access") && ["search", "brave-search"].includes(skill.name)) return false;
					return !(loaded.has("pi-browser-actions") && skill.name === "browser");
				}),
			};
		},
	});
	const reload = loader.reload.bind(loader);
	loader.reload = async () => {
		audit.loaded = [];
		audit.skipped = [];
		await discoverySettings.reload();
		const resources = await packageManager.resolve(async (source) => {
			audit.skipped.push({ path: source, reason: "missing package; headless auto-install disabled" });
			log(`[extensions] skipped missing package (no headless auto-install): ${source}`);
			return "skip";
		});
		extensionPaths.length = 0;
		skillPaths.length = 0;
		resourcesByBridge.clear();
		disposeArtifacts();
		mkdirSync(wrapperDir, { recursive: true, mode: 0o700 });
		const enabledKinds = new Set<ExtensionKind>();
		for (const resource of resources.extensions) {
			const kind = reviewedExtensionKind(resource, options.agentDir);
			const reason = !resource.enabled
				? "disabled in shared config"
				: !kind
					? "not headless allowlisted (TUI/timer/product extensions remain disabled)"
					: enabledKinds.has(kind)
						? `duplicate ${kind} source; loaded once`
						: options.readOnly && kind !== "openai-codex-fast"
							? "read-only summary"
							: kind === "claw-remote" && isSelfRemoteTarget()
								? "self-delegation"
								: kind === "pi-goal-x" && !options.goal
									? "goals need the normal writable chat session"
									: undefined;
			if (reason) {
				audit.skipped.push({ path: resource.path, reason });
				log(`[extensions] skipped ${resource.path}: ${reason}`);
				continue;
			}
			if (!kind) continue;
			enabledKinds.add(kind);
			const path = canonicalPath(resource.path);
			// SDK's jiti loads TypeScript and maps host SDK imports. This bridge imports
			// the selected canonical source, never copies it or imports denied factories.
			const bridge = join(wrapperDir, `${extensionPaths.length}-${kind}.ts`);
			const self = fileURLToPath(import.meta.url);
			const goalMigration =
				kind === "pi-goal-x"
					? [
							`import { readActiveGoalPool, writeActiveGoalFile } from ${JSON.stringify(join(dirname(path), "storage/goal-files.ts"))};`,
							`import { importLegacyGoal } from ${JSON.stringify(join(dirname(self), `goal-compat${extname(self)}`))};`,
							`import { FOCUS_ENTRY } from ${JSON.stringify(join(dirname(path), "goal-format.ts"))};`,
							`import { goalFocusDetails } from ${JSON.stringify(join(dirname(path), "goal-record.ts"))};`,
							`const ctx = { cwd: ${JSON.stringify(options.sessionDir)}, goalStorageRoot: ${JSON.stringify(options.goal?.storageRoot)} };`,
							"let importedGoalId;",
							"importLegacyGoal(ctx.cwd, (goal) => { const pool = readActiveGoalPool(ctx); if (!pool.size) importedGoalId = goal.id; if (!pool.has(goal.id)) writeActiveGoalFile(ctx, goal); });\n",
						].join("\n")
					: "";
			const goalFocus =
				kind === "pi-goal-x"
					? 'if (importedGoalId) pi.on("session_start", () => pi.appendEntry(FOCUS_ENTRY, {...goalFocusDetails(importedGoalId, "migrated"), storageRoot: ctx.goalStorageRoot})); '
					: "";
			writeFileSync(
				bridge,
				kind === "pi-subagents"
					? // Native Agent and its registry lookup must share this bridge's isolated module graph.
						`import factory from ${JSON.stringify(path)};\n` +
							`import { getAgentConfig, resolveSpawnType } from ${JSON.stringify(join(dirname(path), "agent-types.ts"))};\n` +
							`import { createHeadlessSubagentsExtension } from ${JSON.stringify(join(dirname(self), `subagents-extension${extname(self)}`))};\n` +
							`export default function(pi) { createHeadlessSubagentsExtension(pi, factory, (requested) => { const resolved = resolveSpawnType(requested); return resolved.ok ? getAgentConfig(resolved.type) : undefined; }, ${JSON.stringify(options.sessionDir)}); }\n`
					: `import factory from ${JSON.stringify(path)};\n${goalMigration}import { createHeadlessExtensionAPI } from ${JSON.stringify(self)};\nexport default function(pi) { ${goalFocus}return factory(createHeadlessExtensionAPI(pi, ${JSON.stringify(kind)}, ${JSON.stringify(options.sessionDir)})); }\n`,
				{ mode: 0o600 }
			);
			resourcesByBridge.set(canonicalPath(bridge), { kind, resource });
			extensionPaths.push(bridge);
			log(`[extensions] enabled ${kind}: ${path}`);
		}
		if (!options.readOnly)
			for (const resource of resources.skills)
				if (resource.enabled && resource.metadata.scope === "user") skillPaths.push(resource.path);
		await reload();
		for (const extension of loader.getExtensions().extensions) {
			const selected = [...resourcesByBridge.values()].find(
				(item) => canonicalPath(item.resource.path) === canonicalPath(extension.path)
			);
			if (!selected) continue;
			audit.loaded.push(selected.kind);
			extension.sourceInfo = { path: extension.path, ...selected.resource.metadata };
			for (const tool of extension.tools.values()) tool.sourceInfo = extension.sourceInfo;
		}
		if (loader.getExtensions().extensions.some((extension) => extension.path === "<inline:service-scheduler>"))
			audit.loaded.push("scheduler(service)");
		options.settingsManager.applyOverrides({
			transport: "sse",
			defaultTools: options.readOnly ? ["read"] : [...HEADLESS_BUILTIN_TOOLS, "+tool_search"],
		});
	};
	return Object.assign(loader, {
		disposeArtifacts,
		getHeadlessAudit: () => ({ loaded: [...audit.loaded], skipped: audit.skipped.map((entry) => ({ ...entry })) }),
	});
}
