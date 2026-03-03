/**
 * Agent module — manages one AI agent session per iMessage chat.
 *
 * Architecture:
 *   - Each chat (identified by chatGuid) gets a lazily-created AgentSession
 *     with in-memory context (no persistence across restarts).
 *   - Messages are processed sequentially per chat: if the agent is busy,
 *     incoming messages are queued and drained in order once the current
 *     prompt completes.
 *   - Each session subscribes to AgentSessionEvent once at creation time.
 *     On every `message_end` event from the assistant, reply text is accumulated
 *     into `chatSession.replyText`, then sent back via BlueBubbles after the
 *     prompt resolves.
 */

import { getModel } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	SessionManager,
	createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { BBClient } from "./bluebubble/index.js";

const model = getModel("github-copilot", "claude-sonnet-4.6");

export interface AgentManagerConfig {
	blueBubblesClient: BBClient;
}

/** Per-chat mutable state wrapping an AgentSession. */
interface ChatSession {
	session: AgentSession;
	/** True while a prompt is in-flight; subsequent messages go to `queue`. */
	busy: boolean;
	/** Messages waiting to be processed after the current prompt finishes. */
	queue: string[];
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

export function createAgentManager(config: AgentManagerConfig) {
	const { blueBubblesClient } = config;
	/** One ChatSession per chatGuid, kept alive for the process lifetime. */
	const chatSessions = new Map<string, ChatSession>();

	/**
	 * Lazily create an AgentSession for a chat.
	 * The event subscription is set up once here and never torn down —
	 * `replyText` is reset at the start of each `runAgent` call instead.
	 */
	async function getOrCreateSession(chatGuid: string): Promise<ChatSession> {
		const existing = chatSessions.get(chatGuid);
		if (existing) return existing;

		const { session } = await createAgentSession({
			model,
			thinkingLevel: "low",
			sessionManager: SessionManager.inMemory(),
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

	/** Send a single user message to the agent and relay the reply via BlueBubbles. */
	async function runAgent(chatSession: ChatSession, text: string): Promise<void> {
		chatSession.replyText = "";

		try {
			await chatSession.session.prompt(text);
			const reply = chatSession.replyText.trim();
			if (reply) {
				await blueBubblesClient.sendMessage(chatSession.chatGuid, reply);
			}
		} catch (error) {
			console.error(`[blue] Agent error for ${chatSession.chatGuid}:`, error);
		}
	}

	/**
	 * Entry point called by the webhook monitor.
	 * Ensures serial execution per chat — if the agent is already processing,
	 * the message is queued and will be handled once the current run finishes.
	 */
	async function processMessage(chatGuid: string, text: string): Promise<void> {
		const chatSession = await getOrCreateSession(chatGuid);

		if (chatSession.busy) {
			chatSession.queue.push(text);
			return;
		}

		chatSession.busy = true;
		try {
			await runAgent(chatSession, text);
			while (chatSession.queue.length > 0) {
				await runAgent(chatSession, chatSession.queue.shift()!);
			}
		} finally {
			chatSession.busy = false;
		}
	}

	return { processMessage };
}

export type AgentManager = ReturnType<typeof createAgentManager>;
