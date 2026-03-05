/**
 * Agent module — pure text-in / text-out AI processor per iMessage chat.
 *
 * Architecture:
 *   - Each chat (identified by chatGuid) gets a lazily-created AgentSession
 *     with its own persistent context stored under `<workingDir>/<chatGuid>/context.jsonl`.
 *     Conversation history survives process restarts.
 *   - Messages are processed sequentially per chat: if the agent is busy,
 *     incoming messages are queued and drained in order once the current
 *     prompt completes.
 *   - Each session subscribes to AgentSessionEvent once at creation time.
 *     On every `message_end` event from the assistant, reply text is accumulated
 *     into `chatSession.replyText`, returned to the caller after the prompt resolves.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import type { ImageContent } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	SessionManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { IncomingMessage } from "./types.js";

const model = getModel("github-copilot", "claude-sonnet-4.6");

export interface AgentManagerConfig {
	workingDir: string;
}

/** Per-chat mutable state wrapping an AgentSession. */
interface ChatSession {
	session: AgentSession;
	/** True while a prompt is in-flight; subsequent messages go to `queue`. */
	busy: boolean;
	/** Messages waiting to be processed after the current prompt finishes. */
	queue: Array<{ msg: IncomingMessage; resolve: (reply: string | null) => void }>;
	/** Accumulated assistant reply text for the current prompt cycle. Reset before each `runAgent`. */
	replyText: string;
	chatGuid: string;
}

/**
 * Extract concatenated text from an assistant `message_end` event.
 * Content blocks may include text, thinking, or tool_use — we only want text.
 */
function extractReplyText(event: AgentSessionEvent & { type: "message_end" }): string {
	const message = event.message;
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => (part as { type: "text"; text: string }).text)
		.join("\n");
}

/** Sanitize chatGuid for safe use as a directory name. */
function sanitizeChatGuid(chatGuid: string): string {
	return chatGuid.replace(/[^a-zA-Z0-9_\-;+.@]/g, "_");
}

export function createAgentManager(config: AgentManagerConfig) {
	const { workingDir } = config;
	/** One ChatSession per chatGuid, kept alive for the process lifetime. */
	const chatSessions = new Map<string, ChatSession>();

	/**
	 * Lazily create an AgentSession for a chat.
	 * Each chat gets its own `context.jsonl` under `<workingDir>/<chatGuid>/`,
	 * mirroring how pi-mono/mom persists sessions per Slack channel.
	 * The event subscription is set up once here and never torn down —
	 * `replyText` is reset at the start of each `runAgent` call instead.
	 */
	async function getOrCreateSession(chatGuid: string): Promise<ChatSession> {
		const existing = chatSessions.get(chatGuid);
		if (existing) return existing;

		const chatDir = join(workingDir, sanitizeChatGuid(chatGuid));
		mkdirSync(chatDir, { recursive: true });
		const sessionManager = SessionManager.open(join(chatDir, "context.jsonl"), chatDir);

		const { session } = await createAgentSession({
			model,
			thinkingLevel: "low",
			sessionManager,
		});

		const chatSession: ChatSession = { session, busy: false, queue: [], replyText: "", chatGuid };

		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_end") {
				chatSession.replyText += extractReplyText(event as AgentSessionEvent & { type: "message_end" });
			}
		});

		chatSessions.set(chatGuid, chatSession);
		return chatSession;
	}

	/**
	 * Build the prompt text from an IncomingMessage.
	 *
	 * - In group chats the sender is prepended so the LLM knows who is speaking.
	 * - When the message is image-only (no text), a placeholder is used so the
	 *   LLM receives non-empty text alongside the image content.
	 * - If some images failed to download, an inline note is appended.
	 */
	function buildPromptText(msg: IncomingMessage): string {
		let text = msg.text ?? "";

		// Image-only message: give the LLM a hint that an image was sent.
		if (!text && msg.images.length > 0) {
			text = "(image)";
		}

		if (msg.messageType === "group") {
			text = `[${msg.sender}] ${text}`.trim();
		}

		return text;
	}

	/**
	 * Send an IncomingMessage to the agent and return the assistant's reply.
	 *
	 * Uses `session.prompt()` which triggers the full agent loop (tool use,
	 * etc.). When the message contains images they are passed via
	 * `PromptOptions.images` — the same approach as pi's file-processor
	 * (bytes → base64 → ImageContent).
	 */
	async function runAgent(chatSession: ChatSession, msg: IncomingMessage): Promise<string | null> {
		chatSession.replyText = "";
		const promptText = buildPromptText(msg);
		const timeoutMs = 120_000;

		console.log(`[blue] agent prompt start: ${chatSession.chatGuid} "${promptText.substring(0, 60)}"`);

		const promptPromise =
			msg.images.length > 0
				? chatSession.session.prompt(promptText, { images: msg.images })
				: chatSession.session.prompt(promptText);

		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`agent prompt timed out after ${timeoutMs / 1000}s`)), timeoutMs)
		);

		await Promise.race([promptPromise, timeoutPromise]);

		const reply = chatSession.replyText.trim() || null;
		console.log(`[blue] agent prompt end: ${chatSession.chatGuid} reply="${(reply ?? "(null)").substring(0, 60)}"`);
		return reply;
	}

	/**
	 * Process an IncomingMessage, returning the agent's reply.
	 * Ensures serial execution per chat — if the agent is already processing,
	 * the message is queued and will be handled once the current run finishes.
	 */
	async function processMessage(msg: IncomingMessage): Promise<string | null> {
		const chatSession = await getOrCreateSession(msg.chatGuid);

		if (chatSession.busy) {
			return new Promise((resolve) => {
				chatSession.queue.push({ msg, resolve });
			});
		}

		chatSession.busy = true;
		try {
			const reply = await runAgent(chatSession, msg);

			// Drain queue sequentially, resolving each queued promise
			while (chatSession.queue.length > 0) {
				const next = chatSession.queue.shift()!;
				next.resolve(await runAgent(chatSession, next.msg));
			}

			return reply;
		} finally {
			chatSession.busy = false;
		}
	}

	return { processMessage };
}

export type AgentManager = ReturnType<typeof createAgentManager>;
