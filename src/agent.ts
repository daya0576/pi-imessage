/**
 * Agent module — text-in / text-out AI processor per iMessage chat.
 *
 * Each chat gets a lazily-created AgentSession with persistent context
 * (context.jsonl per chat directory).
 *
 * Reply delivery: each tool or assistant event is routed through activeMessageHandler
 * serialized via replyChain so iMessages arrive in order.
 *
 * Model: uses ~/.pi/agent/ defaults (via createAgentSession).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Message, TextContent } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AgentReply, IncomingMessage } from "./types.js";

// ── Config & Types ────────────────────────────────────────────────────────────

export interface AgentManagerConfig {
	workingDir: string;
}

interface ChatSession {
	session: AgentSession;
	chatGuid: string;
	/** Active handler for the message currently being processed; null when session is idle. */
	activeMessageHandler: (reply: AgentReply) => Promise<void>;
	/** Serializes handler calls so iMessages arrive in order. */
	replyChain: Promise<void>;
	/** Tracks in-flight tool calls for duration logging. */
	pendingTools: Map<string, { toolName: string; args: Record<string, unknown>; startTime: number }>;
}

// ── Shared Resources (initialized once) ───────────────────────────────────────

/** Resources that are expensive to create and shared across all chat sessions. */
interface SharedResources {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	resourceLoader: DefaultResourceLoader;
}

/** Create and initialize shared resources (auth, model registry, resource loader). */
async function initSharedResources(workingDir: string): Promise<SharedResources> {
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage);

	// Resource loader with iMessage-specific system prompt; no extensions/skills needed.
	const resourceLoader = new DefaultResourceLoader({
		systemPrompt: buildSystemPrompt(workingDir),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	return { authStorage, modelRegistry, resourceLoader };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a prompt with sender/chat context prefix.
 *
 * Examples:
 *   [DM from +1234567890] hey
 *   [SMS from +1234567890] hey
 *   [Group 'Family' from alice@example.com] hey
 */
function formatPromptText(msg: IncomingMessage): string {
	const text = msg.text ?? "";
	let prefix: string;
	if (msg.messageType === "group") {
		const name = msg.groupName || "unnamed";
		prefix = `[Group '${name}' from ${msg.sender}]`;
	} else if (msg.messageType === "sms") {
		prefix = `[SMS from ${msg.sender}]`;
	} else {
		prefix = `[DM from ${msg.sender}]`;
	}

	if (msg.replyToText) {
		return `${prefix} [replying to: "${msg.replyToText}"] ${text}`;
	}

	return `${prefix} ${text}`;
}

/** Replace characters that are invalid in directory names. */
function sanitizeChatGuid(chatGuid: string): string {
	return chatGuid.replace(/[^a-zA-Z0-9_\-;+.@]/g, "_");
}

/** Read global and chat-specific MEMORY.md files, returning combined content. */
function getMemory(workingDir: string, chatDir?: string): string {
	const parts: string[] = [];

	const globalMemoryPath = join(workingDir, "MEMORY.md");
	if (existsSync(globalMemoryPath)) {
		try {
			const content = readFileSync(globalMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Memory\n${content}`);
			}
		} catch (error) {
			console.warn(`[agent] failed to read global memory: ${error}`);
		}
	}

	if (chatDir) {
		const chatMemoryPath = join(chatDir, "MEMORY.md");
		if (existsSync(chatMemoryPath)) {
			try {
				const content = readFileSync(chatMemoryPath, "utf-8").trim();
				if (content) {
					parts.push(`### Chat Memory\n${content}`);
				}
			} catch (error) {
				console.warn(`[agent] failed to read chat memory: ${error}`);
			}
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : "(no memory yet)";
}

function buildSystemPrompt(workingDir: string, chatDir?: string): string {
	const memory = getMemory(workingDir, chatDir);

	return `You are the user's best friend communicating via iMessage. Be concise. No emojis.

## Context
- Plain text only. Do not use Markdown formatting, double asterisks (**like this**), or [markdown](links).
- Reply in the same language the user is writing in.

## Environment
You are running directly on the host machine.
- Bash working directory: ${workingDir}
- Be careful with system modifications;

## Workspace Layout
${workingDir}/
├── settings.json                # Bot configuration (see below)
├── MEMORY.md                    # Global memory (all chats)
├── SYSTEM.md                    # System configuration log
├── skills/                      # Global CLI tools you create
└── <chatId>/                    # Each iMessage chat gets a directory
    ├── MEMORY.md                # Chat-specific memory
    ├── context.jsonl            # LLM context (session persistence)
    ├── log.jsonl                # Message history
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Chat-specific tools

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workingDir}/MEMORY.md): preferences, project info, shared knowledge
- Chat-specific (<chatDir>/MEMORY.md): user details, ongoing topics, decisions
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workingDir}/SYSTEM.md to log all environment modifications:
- Installed packages (npm install, pip install, brew install, etc.)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment.

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workingDir}/skills/<name>/\` (global) or \`<chatDir>/skills/<name>/\` (chat-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: What this skill does
---
Usage instructions and details here.
\`\`\``;
}

/** Extract concatenated text from a Message, ignoring non-text content parts. */
function extractMessageText(message: Message): string | null {
	if (typeof message.content === "string") return message.content;

	const texts = message.content
		.filter((part): part is TextContent => part.type === "text" && "text" in part)
		.map((part) => part.text);
	const joined = texts.join("\n").trim();
	return joined || null;
}

/** Extract human-readable text from a tool result (string or content-array). */
function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;

	if (result && typeof result === "object" && "content" in result) {
		const content = (result as { content: unknown }).content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const part of content) {
				if (part && typeof part === "object" && part.type === "text" && "text" in part) {
					parts.push(part.text as string);
				}
			}
			const joined = parts.join("\n").trim();
			if (joined) return joined;
		}
	}
	return JSON.stringify(result);
}

/** Pick a human-readable label for a tool invocation. */
function extractToolLabel(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "bash" && typeof args.command === "string") return args.command;
	if (typeof args.path === "string") return `${toolName}: ${args.path}`;
	if (typeof args.label === "string") return args.label;
	return toolName;
}

// ── Agent Manager ─────────────────────────────────────────────────────────────

export async function createAgentManager(config: AgentManagerConfig) {
	const { workingDir } = config;
	const sessionMap = new Map<string, ChatSession>();
	const { modelRegistry, resourceLoader } = await initSharedResources(workingDir);

	/** Create a new AgentSession for a chat, persisted to context.jsonl. */
	async function createSession(chatGuid: string, handler: (reply: AgentReply) => Promise<void>): Promise<ChatSession> {
		const chatDir = join(workingDir, sanitizeChatGuid(chatGuid));
		mkdirSync(chatDir, { recursive: true });
		const sessionManager = SessionManager.open(join(chatDir, "context.jsonl"), chatDir);

		const { session } = await createAgentSession({
			modelRegistry,
			sessionManager,
			resourceLoader,
		});

		const modelLabel = session.model ? `${session.model.provider}/${session.model.id}` : "default";
		console.log(`[agent] session created: ${chatGuid} model=${modelLabel}`);

		const entry: ChatSession = {
			session,
			chatGuid,
			activeMessageHandler: handler,
			replyChain: Promise.resolve(),
			pendingTools: new Map(),
		};
		sessionMap.set(chatGuid, entry);

		// Session-level subscriber — lives for the entire session lifetime so
		// steered messages (injected mid-stream) produce events that are never lost.
		// Reads entry.activeMessageHandler which is updated at the start of each processMessage call.
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				console.log(`[agent] message start: ${chatGuid} role=assistant`);
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				const text = extractMessageText(event.message);
				const stopReason = assistantMsg.stopReason;
				const errorMessage = assistantMsg.errorMessage;
				console.log(
					`[agent] message end: ${chatGuid} role=assistant stopReason=${stopReason}` +
						`${errorMessage ? ` error="${errorMessage}"` : ""}` +
						` text="${(text ?? "(empty)").substring(0, 60)}"`
				);
				if (text) {
					const callback = entry.activeMessageHandler;
					entry.replyChain = entry.replyChain.then(() => callback({ kind: "assistant", text }));
				}
			} else if (event.type === "tool_execution_start") {
				const toolArgs = event.args as Record<string, unknown>;
				const label = extractToolLabel(event.toolName, toolArgs);

				entry.pendingTools.set(event.toolCallId, {
					toolName: event.toolName,
					args: toolArgs,
					startTime: Date.now(),
				});

				console.log(`[agent] tool start: ${chatGuid} → ${label}`);
				const callback = entry.activeMessageHandler;
				entry.replyChain = entry.replyChain.then(() => callback({ kind: "tool_start", label }));
			} else if (event.type === "tool_execution_end") {
				const resultText = extractToolResultText(event.result);
				const pending = entry.pendingTools.get(event.toolCallId);
				entry.pendingTools.delete(event.toolCallId);

				const durationMs = pending ? Date.now() - pending.startTime : 0;
				const duration = (durationMs / 1000).toFixed(1);
				const symbol = event.isError ? "✗" : "✓";

				console.log(
					`[agent] tool end: ${chatGuid} ${symbol} ${event.toolName} (${duration}s)` +
						` result="${resultText.substring(0, 60)}"`
				);
				const callback = entry.activeMessageHandler;
				entry.replyChain = entry.replyChain.then(() =>
					callback({ kind: "tool_end", toolName: event.toolName, symbol, duration, result: resultText })
				);
			}
		});

		return entry;
	}

	/**
	 * Send a user message through the agent and deliver replies via the active message handler.
	 *
	 * Sessions are created on first message. The session-level subscriber fires events
	 * for each tool call and assistant message, routing them through activeMessageHandler.
	 */
	async function processMessage(msg: IncomingMessage, handler: (reply: AgentReply) => Promise<void>): Promise<void> {
		const entry = sessionMap.get(msg.chatGuid) ?? (await createSession(msg.chatGuid, handler));
		entry.activeMessageHandler = handler;

		// Build prompt with sender/chat context prefix
		const promptText = formatPromptText(msg);

		// Refresh system prompt with current memory before each prompt
		const chatDir = join(workingDir, sanitizeChatGuid(msg.chatGuid));
		entry.session.agent.setSystemPrompt(buildSystemPrompt(workingDir, chatDir));

		const currentModel = entry.session.model;
		const currentModelLabel = currentModel ? `${currentModel.provider}/${currentModel.id}` : "default";
		console.log(
			`[agent] prompt start (steer): ${entry.chatGuid} model=${currentModelLabel} "${promptText.substring(0, 60)}"`
		);

		// 1) Session idle   → prompt() blocks until the full agentic run completes.
		// 2) Session active → new message is steered in; prompt() returns immediately,
		//    events (tool_start/end, message_end) keep firing via the subscriber above.
		// TODO: detect active run and fire-and-forget to avoid blocking on a hanging tool.
		await (msg.images.length > 0
			? entry.session.prompt(promptText, { images: msg.images, streamingBehavior: "steer" })
			: entry.session.prompt(promptText, { streamingBehavior: "steer" }));

		await entry.replyChain; // wait for all dispatched replies to finish
		console.log(`[agent] prompt end: ${entry.chatGuid}`);
	}

	/** Start a new session for a chat by deleting context and evicting the in-memory session. */
	async function newSession(chatGuid: string): Promise<void> {
		sessionMap.delete(chatGuid);
		const chatDir = join(workingDir, sanitizeChatGuid(chatGuid));
		const contextFile = join(chatDir, "context.jsonl");
		if (existsSync(contextFile)) {
			unlinkSync(contextFile);
		}
		console.log(`[agent] new session: ${chatGuid}`);
	}

	/**
	 * Get a formatted status string for an active chat session.
	 *
	 * Format (two lines):
	 *   💬 3 msgs - ↑7.2k ↓505 1.1%/128k
	 *   🤖 github-copilot/gpt-5-mini • 💭 minimal
	 */
	async function getSessionStatus(chatGuid: string): Promise<string> {
		const entry = sessionMap.get(chatGuid);
		if (!entry) return "no active session";
		const { session } = entry;
		const stats = session.getSessionStats();
		const contextUsage = session.getContextUsage();
		const model = session.model;
		const thinkingLevel = session.thinkingLevel;

		// Line 1: message count + token counts + context usage
		const line1Parts: string[] = [];
		line1Parts.push(`💬 ${stats.userMessages} msgs`);
		line1Parts.push(`↑${formatTokenCount(stats.tokens.input)}`);
		line1Parts.push(`↓${formatTokenCount(stats.tokens.output)}`);
		if (contextUsage) {
			const percent = contextUsage.percent !== null ? `${contextUsage.percent.toFixed(1)}%` : "?%";
			const window = formatTokenCount(contextUsage.contextWindow);
			line1Parts.push(`${percent}/${window}`);
		}
		const line1 = `${line1Parts[0]} - ${line1Parts.slice(1).join(" ")}`;

		// Line 2: provider/model • thinking level
		const modelLabel = model ? `${model.provider}/${model.id}` : "default";
		const line2 = `🤖 ${modelLabel} • 💭 ${thinkingLevel ?? "off"}`;

		return `${line1}\n${line2}`;
	}

	/**
	 * Switch the requesting session to the current default model from settings.
	 *
	 * Mirrors pi TUI's /model command flow:
	 *   1. modelRegistry.refresh() — reload models from disk
	 *   2. Resolve model from settings (TUI uses manual selection instead)
	 *   3. session.setModel() — updates agent + context.jsonl + settings.json
	 *
	 * Reference: pi-coding-agent/dist/modes/interactive/interactive-mode.js
	 *   handleModelCommand() → getModelCandidates() → session.setModel()
	 */
	async function reload(chatGuid: string): Promise<void> {
		modelRegistry.refresh();
		const settings = SettingsManager.create();
		const provider = settings.getDefaultProvider();
		const modelId = settings.getDefaultModel();
		const newModel = provider && modelId ? modelRegistry.find(provider, modelId) : undefined;

		if (!newModel) {
			console.log("[agent] reload: no default model in settings");
			return;
		}

		const entry = sessionMap.get(chatGuid);
		if (!entry) {
			console.log(`[agent] reload: no active session for ${chatGuid}`);
			return;
		}
		const thinkingLevel = settings.getDefaultThinkingLevel();
		await entry.session.setModel(newModel);
		if (thinkingLevel) {
			entry.session.setThinkingLevel(thinkingLevel);
		}
		console.log(
			`[agent] reloaded: ${chatGuid} switched to ${provider}/${modelId} thinkingLevel=${thinkingLevel ?? "unchanged"}`
		);
	}

	return { processMessage, newSession, getSessionStatus, reload };
}

/** Format a token count as a compact string: 0, 1.2k, 5.9k, 12k, 1.8M, etc. */
function formatTokenCount(tokens: number): string {
	if (tokens === 0) return "0";
	if (tokens < 1_000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export type AgentManager = Pick<
	Awaited<ReturnType<typeof createAgentManager>>,
	"processMessage" | "newSession" | "getSessionStatus" | "reload"
>;
