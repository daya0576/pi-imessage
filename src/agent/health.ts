import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, configure, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { AgentDefaults } from "./chats.ts";

/** Retained metadata for read-only inspection of historical isolated conversations. */
export const Sessions = defineDoc<{
	items: {
		key: string;
		label: string;
		conversationId: ConversationId;
		chatGuid: string;
		deliver: boolean;
		chat?: ConversationId;
	}[];
}>({
	kind: "imessage.sessions",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

/** Explicit health checks reuse one tool-less conversation and never deliver to a chat. */
export async function submitHealth(harness: Harness, defaults: AgentDefaults) {
	const key = JSON.stringify(["health", "model-health"]);
	const id = await harness.commit(async (tx) => {
		const sessions = await tx.doc(Sessions);
		const found = sessions.items.find((item) => item.key === key);
		const id =
			found?.conversationId ?? (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
		await configure(tx, id, { ...defaults, tools: [], instructions: "Reply OK. Do not use tools." });
		if (!found)
			sessions.items.push({
				key,
				label: "model-health",
				conversationId: id,
				chatGuid: "health",
				deliver: false,
			});
		return id;
	}, BACKGROUND_CONTEXT);
	const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
	if (!conversation) throw new Error("Model health conversation missing");
	return conversation.submit(
		{ type: "input", content: "Reply OK.", requestId: crypto.randomUUID(), whenBusy: "followUp" },
		BACKGROUND_CONTEXT,
	);
}
