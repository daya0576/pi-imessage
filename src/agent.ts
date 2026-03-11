/**
 * Agent module — text-in / text-out AI processor per iMessage chat.
 *
 * Each chat gets a lazily-created AgentSession with persistent context
 * (context.jsonl per chat directory).
 *
 * Reply delivery: each tool or assistant event enqueues an onReply call
 * through replyChain, so iMessages arrive in order.
 *
 * Model resolution priority:
 *   1. settings.json modelOverride (defaultProvider / defaultModel / defaultThinkingLevel)
 *   2. ~/.pi/agent/ defaults (via createAgentSession)
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, TextContent } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Settings } from "./settings.js";
import type { IncomingMessage } from "./types.js";

// ── Config & Types ────────────────────────────────────────────────────────────

export interface AgentManagerConfig {
	workingDir: string;
	getSettings: () => Settings;
}

interface ChatSession {
	session: AgentSession;
	chatGuid: string;
	/** Human-readable model label, e.g. "anthropic/claude-sonnet-4" or "default". */
	modelLabel: string;
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

/** Replace characters that are invalid in directory names. */
function sanitizeChatGuid(chatGuid: string): string {
	return chatGuid.replace(/[^a-zA-Z0-9_\-;+.@]/g, "_");
}

function buildSystemPrompt(workingDir: string): string {
	return `You are a helpful personal assistant communicating via iMessage.
- Plain text only. Do not use Markdown formatting, double asterisks (**like this**), or [markdown](links).
- Reply in the same language the user is writing in.

## Workspace Layout
${workingDir}/
├── MEMORY.md                    # Global memory (all chats)
├── skills/                      # Global CLI tools you create
└── <chatId>/                    # Each iMessage chat gets a directory
    ├── MEMORY.md                # Chat-specific memory
    ├── context.jsonl            # LLM context (session persistence)
    ├── log.jsonl                # Message history
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Chat-specific tools

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

// ── Model Resolution ──────────────────────────────────────────────────────────

interface ResolvedModel {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
}

/**
 * Resolve the model from settings.json modelOverride, falling back to
 * createAgentSession defaults (undefined = let the SDK pick).
 */
function resolveModel(modelRegistry: ModelRegistry, settings: Settings): ResolvedModel {
	const override = settings.modelOverride;
	if (!override) return { model: undefined, thinkingLevel: undefined };

	const model = modelRegistry.find(override.defaultProvider, override.defaultModel);
	if (model) {
		console.log(
			`[agent] model override: ${override.defaultProvider}/${override.defaultModel}${override.defaultThinkingLevel ? ` thinking=${override.defaultThinkingLevel}` : ""}`
		);
		return { model, thinkingLevel: override.defaultThinkingLevel };
	}

	// Override specified but model not found — fall back to SDK defaults
	console.log(`[agent] model override not found: ${override.defaultProvider}/${override.defaultModel}, using default`);
	return { model: undefined, thinkingLevel: undefined };
}

// ── Agent Manager ─────────────────────────────────────────────────────────────

export function createAgentManager(config: AgentManagerConfig) {
	const { workingDir, getSettings } = config;
	const sessionMap = new Map<string, ChatSession>();

	// Lazily initialized shared resources (created once on first session request).
	let sharedResourcesPromise: Promise<SharedResources> | null = null;

	/** Get or lazily create shared resources (exactly once). */
	function getSharedResources(): Promise<SharedResources> {
		if (!sharedResourcesPromise) {
			sharedResourcesPromise = initSharedResources(workingDir);
		}
		return sharedResourcesPromise;
	}

	/** Lazily create one AgentSession per chat, persisted to context.jsonl. */
	async function getOrCreateSession(chatGuid: string): Promise<ChatSession> {
		const existing = sessionMap.get(chatGuid);
		if (existing) return existing;

		// Shared resources are created once and reused across all sessions.
		const { modelRegistry, resourceLoader } = await getSharedResources();

		// Per-chat session manager — each chat gets its own context.jsonl.
		const chatDir = join(workingDir, sanitizeChatGuid(chatGuid));
		mkdirSync(chatDir, { recursive: true });
		const sessionManager = SessionManager.open(join(chatDir, "context.jsonl"), chatDir);

		// Resolve model from settings (may be undefined → SDK picks default).
		const { model, thinkingLevel } = resolveModel(modelRegistry, getSettings());

		const { session } = await createAgentSession({
			model,
			thinkingLevel,
			modelRegistry,
			sessionManager,
			resourceLoader,
		});

		const modelLabel = model ? `${model.provider}/${model.id}` : "default";
		console.log(`[agent] session created: ${chatGuid} model=${modelLabel}`);

		const entry: ChatSession = { session, chatGuid, modelLabel };
		sessionMap.set(chatGuid, entry);
		return entry;
	}

	/**
	 * Send a user message through the agent and deliver replies via onReply.
	 *
	 * Events are serialized: each tool_execution_start/end and assistant
	 * message_end enqueues an onReply call through replyChain so iMessages
	 * arrive in order.
	 */
	async function processMessage(msg: IncomingMessage, onReply: (reply: string) => Promise<void>): Promise<void> {
		const entry = await getOrCreateSession(msg.chatGuid);

		// Track pending tool calls for duration logging
		const pendingTools = new Map<string, { toolName: string; args: Record<string, unknown>; startTime: number }>();

		// Serialize onReply calls — subscribe is sync so we chain promises
		let replyChain = Promise.resolve();
		const unsub = entry.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				const text = extractMessageText(event.message);
				const stopReason = assistantMsg.stopReason;
				const errorMessage = assistantMsg.errorMessage;
				console.log(
					`[agent] message end: ${entry.chatGuid} role=assistant stopReason=${stopReason}` +
						`${errorMessage ? ` error="${errorMessage}"` : ""}` +
						` text="${(text ?? "(empty)").substring(0, 60)}"`
				);
				if (text) {
					replyChain = replyChain.then(() => onReply(text));
				}
			} else if (event.type === "tool_execution_start") {
				const toolArgs = event.args as Record<string, unknown>;
				const label = extractToolLabel(event.toolName, toolArgs);

				pendingTools.set(event.toolCallId, {
					toolName: event.toolName,
					args: toolArgs,
					startTime: Date.now(),
				});

				console.log(`[agent] tool start: ${entry.chatGuid} → ${label}`);
				replyChain = replyChain.then(() => onReply(`→ ${label}`));
			} else if (event.type === "tool_execution_end") {
				const resultText = extractToolResultText(event.result);
				const pending = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);

				const durationMs = pending ? Date.now() - pending.startTime : 0;
				const duration = (durationMs / 1000).toFixed(1);
				const symbol = event.isError ? "✗" : "✓";
				const truncatedResult = resultText.length > 500 ? `${resultText.substring(0, 500)}…` : resultText;
				const message = `${symbol} ${event.toolName} (${duration}s)\n${truncatedResult}`;

				console.log(
					`[agent] tool end: ${entry.chatGuid} ${symbol} ${event.toolName} (${duration}s)` +
						` result="${resultText.substring(0, 60)}"`
				);
				replyChain = replyChain.then(() => onReply(message));
			}
		});

		const promptText = msg.text ?? "";
		console.log(`[agent] prompt start: ${entry.chatGuid} model=${entry.modelLabel} "${promptText.substring(0, 60)}"`);

		const promptPromise =
			msg.images.length > 0
				? entry.session.prompt(promptText, { images: msg.images })
				: entry.session.prompt(promptText);

		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("agent prompt timed out after 120s")), 120_000)
		);

		try {
			await Promise.race([promptPromise, timeoutPromise]);
			await replyChain; // wait for all dispatched replies to finish
			console.log(`[agent] prompt end: ${entry.chatGuid}`);
		} finally {
			unsub();
		}
	}

	/**
	 * Reset the agent session for a chat, starting a new session
	 * (equivalent to /new in the coding agent).
	 * Returns true if a session existed and was reset, false if no session existed.
	 */
	async function resetSession(chatGuid: string): Promise<boolean> {
		const existing = sessionMap.get(chatGuid);
		if (!existing) return false;
		await existing.session.newSession();
		console.log(`[agent] session reset: ${chatGuid}`);
		return true;
	}

	/**
	 * Get a formatted status string for a chat session.
	 * Lazily creates/resumes the session from disk if not already in memory.
	 *
	 * Format (two lines):
	 *   💬 3 msgs - ↑7.2k ↓505 1.1%/128k
	 *   🤖 github-copilot/gpt-5-mini • 💭 minimal
	 */
	async function getSessionStatus(chatGuid: string): Promise<string> {
		const entry = await getOrCreateSession(chatGuid);
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
		const modelLabel = model ? `${model.provider}/${model.id}` : entry.modelLabel;
		const line2 = `🤖 ${modelLabel} • 💭 ${thinkingLevel ?? "off"}`;

		return `${line1}\n${line2}`;
	}

	return { processMessage, resetSession, getSessionStatus };
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
	ReturnType<typeof createAgentManager>,
	"processMessage" | "resetSession" | "getSessionStatus"
>;
