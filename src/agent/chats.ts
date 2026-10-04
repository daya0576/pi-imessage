import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineDoc,
	type Harness,
	type ModelRef,
	UserEntry,
} from "@earendil-works/pi-durable";

export const Chats = defineDoc<{ items: { chatGuid: string; conversationId: ConversationId }[] }>({
	kind: "imessage.chats",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

export const WatchCursor = defineDoc<{ rowid?: number }>({
	kind: "imessage.watch-cursor",
	version: 1,
	scope: "session",
	initial: () => ({}),
});

export type AgentDefaults = { model: ModelRef; thinkingLevel?: ModelThinkingLevel };

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
	return conversation.submit(
		reply
			? { type: "input", content, requestId: guid, whenBusy: "steer" }
			: {
					type: "write",
					requestId: guid,
					entry: {
						kind: UserEntry.kind,
						model: [{ role: "user", content, timestamp: Date.now() }],
					},
				},
		BACKGROUND_CONTEXT,
	);
}
