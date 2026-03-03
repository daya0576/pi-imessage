/**
 * Agent module — creates and runs agent sessions per chat.
 *
 * Uses pi-coding-agent SDK to create sessions with persistent storage,
 * sends user messages, and collects assistant replies.
 */

import { createAgentSession, type AgentSession, type AgentSessionEvent, SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { BBClient } from "./bb.js";
import type { Store } from "./store.js";

export interface AgentManagerConfig {
  store: Store;
  bb: BBClient;
}

interface ChatSession {
  session: AgentSession;
  busy: boolean;
  queue: Array<{ text: string; chatGuid: string }>;
}

export function createAgentManager(config: AgentManagerConfig) {
  const { store, bb } = config;
  const chatSessions = new Map<string, ChatSession>();

  async function getOrCreateSession(chatGuid: string): Promise<ChatSession> {
    let cs = chatSessions.get(chatGuid);
    if (cs) return cs;

    const sm = store.getSessionManager(chatGuid);
    const model = getModel("anthropic", "claude-sonnet-4-20250514");

    const { session } = await createAgentSession({
      model,
      thinkingLevel: "low",
      sessionManager: sm,
    });

    cs = { session, busy: false, queue: [] };
    chatSessions.set(chatGuid, cs);
    return cs;
  }

  async function processMessage(chatGuid: string, text: string): Promise<void> {
    const cs = await getOrCreateSession(chatGuid);

    if (cs.busy) {
      cs.queue.push({ text, chatGuid });
      return;
    }

    cs.busy = true;
    try {
      await runAgent(cs, chatGuid, text);

      // Drain queue
      while (cs.queue.length > 0) {
        const next = cs.queue.shift()!;
        await runAgent(cs, next.chatGuid, next.text);
      }
    } finally {
      cs.busy = false;
    }
  }

  async function runAgent(cs: ChatSession, chatGuid: string, text: string): Promise<void> {
    // Collect assistant reply text from events
    let replyText = "";

    const unsub = cs.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_end") {
        const msg = event.message;
        if (msg && "role" in msg && msg.role === "assistant" && "content" in msg) {
          // Extract text from content blocks
          const content = msg.content;
          if (typeof content === "string") {
            replyText += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === "string") {
                replyText += block;
              } else if ("type" in block && block.type === "text" && "text" in block) {
                replyText += (block as { type: "text"; text: string }).text;
              }
            }
          }
        }
      }
    });

    try {
      await cs.session.prompt(text);

      if (replyText.trim()) {
        await bb.sendMessage(chatGuid, replyText.trim());
      }
    } catch (err) {
      console.error(`[blue] Agent error for ${chatGuid}:`, err);
      await bb.sendMessage(chatGuid, "⚠️ Something went wrong. Please try again.");
    } finally {
      unsub();
    }
  }

  return { processMessage };
}

export type AgentManager = ReturnType<typeof createAgentManager>;
