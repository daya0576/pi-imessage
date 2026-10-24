import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ConversationRecord,
	Cursor,
	EntryId,
	EntryRecord,
	Harness,
	TaskId,
	TaskRecord,
} from "@earendil-works/pi-durable";
import { displayHistory, historyActivity } from "./history.ts";

/** Newest tasks listed per conversation; older finished ones are only flagged. */
export const RECENT_TASKS_PER_CONVERSATION = 20;

type Summary = TaskRecord<unknown, unknown, unknown>;

/**
 * Read one consistent tree, newest first: all conversations, every unfinished task, every task that owns a
 * conversation, their parent chains and the newest tasks of each conversation. Descending scans stop at the
 * window instead of reading the whole task history (earendil-works/pi#10546).
 */
export function readTaskTree(harness: Harness) {
	return harness.commit(async (tx) => {
		const conversations: (ConversationRecord & { updatedAt: number; groupName?: string })[] = [];
		const kept = new Map<TaskId, Summary>();
		const more: Record<string, true> = {};
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
				const newest = await tx.scanTasks(
					{ conversationId: conversation.id, order: "descending" },
					RECENT_TASKS_PER_CONVERSATION + 1,
				);
				for (const task of newest.items.slice(0, RECENT_TASKS_PER_CONVERSATION)) kept.set(task.id, task);
				if (newest.items.length > RECENT_TASKS_PER_CONVERSATION) more[conversation.id] = true;
				if (conversation.owner && !kept.has(conversation.owner.taskId)) {
					const owner = await tx.task(conversation.owner.taskId);
					if (owner) kept.set(owner.id, owner);
				}
			}
			cursor = page.next;
		} while (cursor);
		// Unfinished tasks can be old (sleeping schedulers); status scans are small.
		for (const status of ["pending", "running", "waiting", "sleeping"] as const) {
			cursor = undefined;
			do {
				const page = await tx.scanTasks({ status, order: "descending" }, 100, cursor);
				for (const task of page.items) kept.set(task.id, task);
				cursor = page.next;
			} while (cursor);
		}
		// A kept child needs its parent chain so the tree can place it.
		for (const task of [...kept.values()]) {
			for (let owner = task.owner; owner !== undefined && !kept.has(owner); owner = kept.get(owner)?.owner) {
				const parent = await tx.task(owner);
				if (!parent) break;
				kept.set(parent.id, parent);
			}
		}
		const assistants = new Map<EntryId, EntryRecord | undefined>();
		const tasks = [];
		for (const task of [...kept.values()].sort((a, b) => Number(b.id) - Number(a.id))) {
			let name: string | undefined;
			const input = task.input;
			if (task.kind === "pi.tool" && input && typeof input === "object" && !Array.isArray(input)) {
				const call = input as { assistant?: unknown; callId?: unknown };
				if (typeof call.assistant === "number" && typeof call.callId === "string") {
					const id = call.assistant as EntryId;
					if (!assistants.has(id)) assistants.set(id, await tx.entry(id));
					for (const message of assistants.get(id)?.model ?? []) {
						if (message.role !== "assistant") continue;
						const block = message.content.find((item) => item.type === "toolCall" && item.id === call.callId);
						if (block?.type === "toolCall") name = block.name;
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
						? (state.checkpoint as { phase?: unknown }).phase
						: undefined,
				on: state.status === "waiting" ? state.on : undefined,
				outcome: state.outcome?.status,
			});
		}
		return { conversations, tasks, more };
	}, BACKGROUND_CONTEXT);
}
