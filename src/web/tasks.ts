import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationRecord, Cursor, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { displayHistory, historyActivity } from "./history.ts";

/** Read one consistent tree, including terminal receipts and task-owned conversations. */
export function readTaskTree(harness: Harness) {
	return harness.commit(async (tx) => {
		const conversations: (ConversationRecord & { updatedAt: number; groupName?: string })[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 100, cursor);
			for (const conversation of page.items) {
				const history = await tx.scanEntries({ conversationId: conversation.id }, 100);
				const { groupName } = displayHistory(history, 1);
				conversations.push({
					...conversation,
					updatedAt: historyActivity(history),
					groupName: typeof groupName === "string" ? groupName : undefined,
				});
			}
			cursor = page.next;
		} while (cursor);
		const tasks = [];
		const assistants = new Map<EntryId, EntryRecord | undefined>();
		do {
			const page = await tx.scanTasks({}, 100, cursor);
			for (const task of page.items) {
				let name: string | undefined;
				const input = task.input;
				if (task.kind === "pi.tool" && input && typeof input === "object" && !Array.isArray(input)) {
					if (typeof input.assistant === "number" && typeof input.callId === "string") {
						const id = input.assistant as EntryId;
						if (!assistants.has(id)) assistants.set(id, await tx.entry(id));
						for (const message of assistants.get(id)?.model ?? []) {
							if (message.role !== "assistant") continue;
							const call = message.content.find(
								(block) => block.type === "toolCall" && block.id === input.callId,
							);
							if (call?.type === "toolCall") name = call.name;
						}
					}
				}
				const state = task.state;
				tasks.push({
					id: task.id,
					conversationId: task.conversationId,
					owner: task.owner,
					kind: task.kind,
					name,
					background: task.background,
					abortRequested: task.abortRequested,
					status: state.status,
					phase:
						state.checkpoint && typeof state.checkpoint === "object" && !Array.isArray(state.checkpoint)
							? state.checkpoint.phase
							: undefined,
					on: state.status === "waiting" ? state.on : undefined,
					outcome: state.outcome?.status,
				});
			}
			cursor = page.next;
		} while (cursor);
		return { conversations, tasks };
	}, BACKGROUND_CONTEXT);
}
