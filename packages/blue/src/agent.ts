/**
 * Agent module — text-in / text-out AI processor per iMessage chat.
 *
 * Each chat gets a lazily-created AgentSession with persistent context.
 * Messages are processed sequentially per chat via a serial queue.
 * Replies are streamed per message: each message_end event (assistant or toolResult) invokes onReply,
 * serialized via replyChain so iMessages are sent in order.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Message, type TextContent, getModel } from "@mariozechner/pi-ai";
import { type AgentSession, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import type { IncomingMessage } from "./types.js";

const model = getModel("github-copilot", "claude-sonnet-4.6");

export interface AgentManagerConfig {
	workingDir: string;
}

interface ChatSession {
	session: AgentSession;
	chatGuid: string;
}

function sanitizeChatGuid(chatGuid: string): string {
	return chatGuid.replace(/[^a-zA-Z0-9_\-;+.@]/g, "_");
}

function extractMessageText(message: Message): string | null {
	if (typeof message.content === "string") return message.content;
	
  const texts = message.content
		.filter((part): part is TextContent => part.type === "text" && "text" in part)
		.map((part) => part.text);
	const joined = texts.join("\n").trim();
	return joined || null;
}

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
	// bash → show the command
	if (toolName === "bash" && typeof args.command === "string") return args.command;
	// read/write/edit → show the path
	if (typeof args.path === "string") return `${toolName}: ${args.path}`;
	// fallback to explicit label or tool name
	if (typeof args.label === "string") return args.label;
	return toolName;
}

export function createAgentManager(config: AgentManagerConfig) {
	const { workingDir } = config;
	const sessionMap = new Map<string, ChatSession>();

	async function getOrCreateSession(chatGuid: string): Promise<ChatSession> {
		const existing = sessionMap.get(chatGuid);
		if (existing) return existing;

		const chatDir = join(workingDir, sanitizeChatGuid(chatGuid));
		mkdirSync(chatDir, { recursive: true });
		const sessionManager = SessionManager.open(join(chatDir, "context.jsonl"), chatDir);

		const { session } = await createAgentSession({
			model,
			thinkingLevel: "low",
			sessionManager,
		});

		const entry: ChatSession = { session, chatGuid };
		sessionMap.set(chatGuid, entry);
		return entry;
	}

	/** Prompt the agent and invoke onReply for each message_end (assistant or toolResult) that produces text. Replies are serialized. */
	async function processMessage(msg: IncomingMessage, onReply: (reply: string) => Promise<void>): Promise<void> {
		const entry = await getOrCreateSession(msg.chatGuid);

		// Track pending tool calls for duration and args
		const pendingTools = new Map<string, { toolName: string; args: Record<string, unknown>; startTime: number }>();

		// Serialize onReply calls — subscribe is sync so we chain promises
		let replyChain = Promise.resolve();
		const unsub = entry.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const text = extractMessageText(event.message);
				console.log(`[blue] message end: ${entry.chatGuid} role=assistant text="${(text ?? "(empty)").substring(0, 60)}"`);
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

				console.log(`[blue] tool execution start: ${entry.chatGuid} → ${label}`);
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

				console.log(`[blue] tool execution end: ${entry.chatGuid} ${symbol} ${event.toolName} (${duration}s) result="${resultText.substring(0, 60)}"`);
				replyChain = replyChain.then(() => onReply(message));
			}
		});

		const promptText = msg.text ?? "";
		console.log(`[agent] agent prompt start: ${entry.chatGuid} "${promptText.substring(0, 60)}"`);

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
			console.log(`[blue] agent prompt end: ${entry.chatGuid}`);
		} finally {
			unsub();
		}
	}

	return { processMessage };
}

export type AgentManager = ReturnType<typeof createAgentManager>;
