import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import {
	type Conversation,
	type ConversationId,
	configure,
	defineDoc,
	type Harness,
	type ModelRef,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { Settings } from "../config/settings.ts";
import { activeRun, Runs } from "./run.ts";

/** `progress` and `interim` are the chat's /verbose and /interim choices; absent means follow `settings.json`. */
export type ChatRecord = {
	chatGuid: string;
	conversationId: ConversationId;
	progress?: boolean;
	interim?: boolean;
};

export const Chats = defineDoc<{ items: ChatRecord[] }>({
	kind: "imessage.chats",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
	checkpointWhen: () => false,
});

export const WatchCursor = defineDoc<{ rowid?: number }>({
	kind: "imessage.watch-cursor",
	version: 1,
	scope: "session",
	initial: () => ({}),
	checkpointWhen: () => false,
});

export type AgentDefaults = { model: ModelRef; thinkingLevel?: ModelThinkingLevel };

export function progressEnabled(settings: Settings, chats: ChatRecord[], chatGuid: string) {
	return chats.find((chat) => chat.chatGuid === chatGuid)?.progress ?? settings.progressMessages;
}

export function interimEnabled(settings: Settings, chats: ChatRecord[], chatGuid: string) {
	return chats.find((chat) => chat.chatGuid === chatGuid)?.interim ?? settings.interimMessages;
}

/** Stores a chat's /verbose or /interim choice; `undefined` returns the chat to the global setting. */
export async function setChatSwitch(
	harness: Harness,
	chatGuid: string,
	name: "progress" | "interim",
	value: boolean | undefined,
) {
	await harness.commit(async (tx) => {
		const chats = await tx.doc(Chats);
		const index = chats.items.findIndex((item) => item.chatGuid === chatGuid);
		if (index < 0) throw new Error("Chat conversation is missing");
		const { [name]: _previous, ...rest } = chats.items[index];
		// Replace the record so the stored delta never carries an undefined value.
		chats.items.splice(index, 1, value === undefined ? rest : { ...rest, [name]: value });
	}, BACKGROUND_CONTEXT);
}

export type MessageInput = {
	chatGuid: string;
	/** Source message GUID or another stable key; Durable deduplicates by it. */
	guid: string;
	text: string;
	sender?: string;
	service?: string;
	groupName?: string;
	replyTo?: string | null;
	/** Archived local paths; the model reads them on demand. */
	attachments?: string[];
};

export function formatInput(input: MessageInput) {
	let prefix = "";
	if (input.sender !== undefined) {
		if (input.chatGuid.includes(";+;"))
			prefix = `[Group '${input.groupName || "unnamed"}' from ${input.sender}] `;
		else prefix = `[${input.service === "SMS" ? "SMS" : "DM"} from ${input.sender}] `;
	}
	const reply = input.replyTo ? `[replying to: "${input.replyTo}"] ` : "";
	const files = (input.attachments ?? []).map((path) => `\n[Attachment: ${path}]`).join("");
	return `${prefix}${reply}${input.text}${files}`;
}

export async function chatConversation(harness: Harness, defaults: AgentDefaults, chatGuid: string) {
	const conversationId = await harness.commit(async (tx) => {
		const chats = await tx.doc(Chats);
		const existing = chats.items.find((chat) => chat.chatGuid === chatGuid);
		if (existing) return existing.conversationId;
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await configure(tx, conversation.id, defaults);
		chats.items.push({ chatGuid, conversationId: conversation.id });
		return conversation.id;
	}, BACKGROUND_CONTEXT);
	const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
	if (!conversation) throw new Error("Chat conversation is missing");
	return conversation;
}

/** A chat whose last turn ended this long ago with at least this much context starts fresh (ADR 0055). */
export const IDLE_RESET_AFTER_MS = 3600000;
export const IDLE_RESET_MIN_TOKENS = 60000;

/**
 * One context read, as /status does. The last message is the assistant's only when the chat is idle at a turn
 * boundary, so a busy chat is never reset.
 */
async function resetIdleContext(conversation: Conversation, now: number) {
	const last = (await conversation.context(BACKGROUND_CONTEXT)).messages.at(-1);
	if (last?.role !== "assistant") return false;
	const tokens = calculateContextTokens(last.usage);
	if (tokens <= IDLE_RESET_MIN_TOKENS || now - last.timestamp <= IDLE_RESET_AFTER_MS) return false;
	await conversation.reset(undefined, BACKGROUND_CONTEXT);
	console.log(new Date(now).toISOString(), "Idle context reset", {
		conversation: conversation.id,
		tokens,
		idleMinutes: Math.round((now - last.timestamp) / 60000),
	});
	return true;
}

export async function submitMessage(
	harness: Harness,
	defaults: AgentDefaults,
	input: MessageInput,
	reply = true,
) {
	// Snapshot before awaiting: callers may reuse their input object.
	const guid = input.guid;
	const content = formatInput(input);
	if (!input.chatGuid.trim() || !guid.trim() || (!input.text.trim() && !input.attachments?.length))
		throw new Error("Chat GUID, message GUID and content are required");
	const conversation = await chatConversation(harness, defaults, input.chatGuid);
	const log = {
		type: "write",
		requestId: guid,
		entry: { kind: UserEntry.kind, model: [{ role: "user", content, timestamp: Date.now() }] },
	} as const;
	if (!reply) return conversation.submit(log, BACKGROUND_CONTEXT);
	const message = { type: "input", content, requestId: guid, whenBusy: "steer" } as const;
	const run = activeRun((await harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items, conversation.id);
	const target = run && (await harness.conversation(run.conversationId, BACKGROUND_CONTEXT));
	if (!target) {
		await resetIdleContext(conversation, Date.now());
		return conversation.submit(message, BACKGROUND_CONTEXT);
	}
	// During a run, the chat has one place where work happens; its own conversation keeps the record.
	const submission = await target.submit(message, BACKGROUND_CONTEXT);
	await conversation.submit(log, BACKGROUND_CONTEXT);
	return submission;
}
