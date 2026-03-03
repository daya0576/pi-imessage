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
import {
	type AgentSession,
	type AgentSessionEvent,
	SessionManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";

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
	queue: Array<{ text: string; resolve: (reply: string | null) => void }>;
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
	 * Send a single message to the agent.
	 * Returns the assistant's reply text, or null if the agent produced no output.
	 */
	async function runAgent(chatSession: ChatSession, text: string): Promise<string | null> {
		chatSession.replyText = "";
		await chatSession.session.prompt(text);
		return chatSession.replyText.trim() || null;
	}

	/**
	 * Process a message for a chat, returning the agent's reply.
	 * Ensures serial execution per chat — if the agent is already processing,
	 * the message is queued and will be handled once the current run finishes.
	 */
	async function processMessage(chatGuid: string, text: string): Promise<string | null> {
		const chatSession = await getOrCreateSession(chatGuid);

		if (chatSession.busy) {
			return new Promise((resolve) => {
				chatSession.queue.push({ text, resolve });
			});
		}

		chatSession.busy = true;
		try {
			const reply = await runAgent(chatSession, text);

			// Drain queue sequentially, resolving each queued promise
			while (chatSession.queue.length > 0) {
				const next = chatSession.queue.shift()!;
				next.resolve(await runAgent(chatSession, next.text));
			}

			return reply;
		} finally {
			chatSession.busy = false;
		}
	}

	return { processMessage };
}

export type AgentManager = ReturnType<typeof createAgentManager>;
