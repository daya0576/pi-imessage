import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ConversationId,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryRecord,
	Harness,
	TaskId,
	TaskRecord,
} from "@earendil-works/pi-durable";
import { Chats } from "../agent/chats.ts";
import { displayHistory, historyActivity } from "./history.ts";

/** Newest tasks listed per conversation; older finished ones are only flagged. */
export const RECENT_TASKS_PER_CONVERSATION = 20;

type Summary = TaskRecord<unknown, unknown, unknown>;

/** Read only the five most recently active chats, or one explicitly selected conversation. */
export function readTaskTree(harness: Harness, conversationId?: ConversationId) {
	return harness.commit(async (tx) => {
		const conversations: (ConversationRecord & { updatedAt: number; groupName?: string })[] = [];
		const kept = new Map<TaskId, Summary>();
		const more: Record<string, true> = {};
		const chats = await tx.doc(Chats);
		const candidates = [];
		for (const id of conversationId === undefined
			? chats.items.map((chat) => chat.conversationId)
			: [conversationId]) {
			const conversation = await tx.conversation(id);
			if (!conversation) continue;
			const history = await tx.scanEntries({ conversationId: id }, 100);
			const { groupName } = displayHistory(history, 1);
			candidates.push({
				...conversation,
				updatedAt: historyActivity(history),
				groupName: typeof groupName === "string" ? groupName : undefined,
			});
		}
		const selected = candidates
			.sort((a, b) => b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id))
			.slice(0, 5);
		const queued = new Set(selected.map((conversation) => conversation.id));
		// Expand only children owned by tasks in this window, not every historical subagent.
		for (const conversation of selected) {
			conversations.push(conversation);
			const newest = await tx.scanTasks(
				{ conversationId: conversation.id, order: "descending" },
				RECENT_TASKS_PER_CONVERSATION + 1,
			);
			const local = new Map<TaskId, Summary>(
				newest.items.slice(0, RECENT_TASKS_PER_CONVERSATION).map((task) => [task.id, task]),
			);
			if (newest.items.length > RECENT_TASKS_PER_CONVERSATION) more[conversation.id] = true;
			for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
				let cursor: Cursor | undefined;
				do {
					const page = await tx.scanTasks({ conversationId: conversation.id, status }, 100, cursor);
					for (const task of page.items) local.set(task.id, task);
					cursor = page.next;
				} while (cursor);
			}
			for (const task of local.values()) {
				for (let owner = task.owner; owner !== undefined && !local.has(owner) && !kept.has(owner); ) {
					const parent = await tx.task(owner);
					if (!parent) break;
					local.set(parent.id, parent);
					owner = parent.owner;
				}
			}
			for (const task of local.values()) {
				kept.set(task.id, task);
				let cursor: Cursor | undefined;
				do {
					const page = await tx.scanConversations({ ownerTaskId: task.id }, 100, cursor);
					for (const child of page.items) {
						if (queued.has(child.id)) continue;
						queued.add(child.id);
						selected.push({ ...child, updatedAt: conversation.updatedAt, groupName: undefined });
					}
					cursor = page.next;
				} while (cursor);
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
