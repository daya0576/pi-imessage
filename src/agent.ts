/**
 * Agent module — text-in / text-out AI processor per iMessage chat.
 *
 * Each chat gets a lazily-created AgentSession with persistent context
 * (context.jsonl per chat directory).
 *
 * Concurrency: callers must serialize messages for the same chat externally
 * (imessage.ts does this via per-chat promise chains). Different chats run
 * concurrently.
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
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

/** Read a file's trimmed content, or return undefined if missing/empty. */
function readFileIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const content = readFileSync(path, "utf-8").trim();
		return content || undefined;
	} catch (error) {
		console.warn(`[agent] failed to read ${path}: ${error}`);
		return undefined;
	}
}

/** Read global and chat-specific MEMORY.md files, returning combined content. */
function getMemory(workingDir: string, chatDir?: string): string {
	const parts: string[] = [];
	const global = readFileIfExists(join(workingDir, "MEMORY.md"));
	if (global) parts.push(`### Global Memory\n${global}`);
	if (chatDir) {
		const chat = readFileIfExists(join(chatDir, "MEMORY.md"));
		if (chat) parts.push(`### Chat Memory\n${chat}`);
	}
	return parts.length > 0 ? parts.join("\n\n") : "(no memory yet)";
}

function getCustomPrompt(workingDir: string, chatDir?: string): string {
	const parts: string[] = [];
	const global = readFileIfExists(join(workingDir, "SYSTEM.md"));
	if (global) parts.push(global);
	if (chatDir) {
		const chat = readFileIfExists(join(chatDir, "SYSTEM.md"));
		if (chat) parts.push(chat);
	}
	return parts.join("\n\n");
}

function buildSystemPrompt(workingDir: string, chatDir?: string): string {
	const memory = getMemory(workingDir, chatDir);
	const customPrompt = getCustomPrompt(workingDir, chatDir);

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
\`\`\`${customPrompt ? `\n\n${customPrompt}` : ""}`;
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

	const modelRegistry = new ModelRegistry(AuthStorage.create());
	const resourceLoader = new DefaultResourceLoader({
		systemPrompt: buildSystemPrompt(workingDir),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	/** Create a new AgentSession for a chat, persisted to context.jsonl. */
	async function createSession(chatGuid: string): Promise<ChatSession> {
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

		const entry: ChatSession = { session, chatGuid };
		sessionMap.set(chatGuid, entry);
		return entry;
	}

	/**
	 * Send a user message through the agent and deliver replies via the handler.
	 *
	 * Callers must serialize calls for the same chat (imessage.ts does this).
	 */
	async function processMessage(msg: IncomingMessage, handler: (reply: AgentReply) => Promise<void>): Promise<void> {
		const entry = sessionMap.get(msg.chatGuid) ?? (await createSession(msg.chatGuid));
		const { session, chatGuid } = entry;

		const promptText = formatPromptText(msg);
		const chatDir = join(workingDir, sanitizeChatGuid(chatGuid));
		session.agent.setSystemPrompt(buildSystemPrompt(workingDir, chatDir));

		const images = msg.images.length > 0 ? msg.images : undefined;
		const modelLabel = session.model ? `${session.model.provider}/${session.model.id}` : "default";
		console.log(`[agent] prompt start: ${chatGuid} model=${modelLabel} "${promptText.substring(0, 60)}"`);

		// Subscribe for this prompt's lifetime, routing events through handler
		let replyChain = Promise.resolve();
		const pendingTools = new Map<string, { toolName: string; startTime: number }>();

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				console.log(`[agent] message start: ${chatGuid} role=assistant`);
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				const text = extractMessageText(event.message);
				console.log(
					`[agent] message end: ${chatGuid} stopReason=${assistantMsg.stopReason}` +
						`${assistantMsg.errorMessage ? ` error="${assistantMsg.errorMessage}"` : ""}` +
						` text="${(text ?? "(empty)").substring(0, 60)}"`
				);
				if (text) {
					replyChain = replyChain.then(() => handler({ kind: "assistant", text }));
				}
			} else if (event.type === "tool_execution_start") {
				const toolArgs = event.args as Record<string, unknown>;
				const label = extractToolLabel(event.toolName, toolArgs);
				pendingTools.set(event.toolCallId, { toolName: event.toolName, startTime: Date.now() });
				console.log(`[agent] tool start: ${chatGuid} → ${label}`);
				replyChain = replyChain.then(() => handler({ kind: "tool_start", label }));
			} else if (event.type === "tool_execution_end") {
				const resultText = extractToolResultText(event.result);
				const pending = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);
				const duration = ((pending ? Date.now() - pending.startTime : 0) / 1000).toFixed(1);
				const symbol = event.isError ? "✗" : "✓";
				console.log(
					`[agent] tool end: ${chatGuid} ${symbol} ${event.toolName} (${duration}s)` +
						` result="${resultText.substring(0, 60)}"`
				);
				replyChain = replyChain.then(() =>
					handler({ kind: "tool_end", toolName: event.toolName, symbol, duration, result: resultText })
				);
			}
		});

		try {
			await session.prompt(promptText, { images });
			await replyChain;
			console.log(`[agent] prompt end: ${chatGuid}`);
		} finally {
			unsubscribe();
		}
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
