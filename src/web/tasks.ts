import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	ConversationId,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryRecord,
	Harness,
	TaskId,
} from "@earendil-works/pi-durable";
import { displayHistory, historyActivity } from "./history.ts";

/** Terminal tasks kept per conversation; the rest are counted, not listed. */
export const RECENT_TASKS_PER_CONVERSATION = 20;

/** Read one consistent tree: all conversations, active tasks, tasks that own conversations and recent terminal tasks. */
export function readTaskTree(harness: Harness) {
	return harness.commit(async (tx) => {
		const conversations: (ConversationRecord & { updatedAt: number; groupName?: string })[] = [];
		const owningTasks = new Set<TaskId>();
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
				if (conversation.owner) owningTasks.add(conversation.owner.taskId);
			}
			cursor = page.next;
		} while (cursor);
		type Summary = Awaited<ReturnType<typeof tx.scanTasks>>["items"][number];
		const kept = new Map<TaskId, Summary>();
		const recent = new Map<ConversationId, Summary[]>();
		const hidden: Record<string, number> = {};
		do {
			const page = await tx.scanTasks({}, 100, cursor);
			for (const task of page.items) {
				if (task.state.status !== "terminal" || owningTasks.has(task.id)) {
					kept.set(task.id, task);
					continue;
				}
				// Newest IDs are the most recent; keep a bounded window per conversation.
				const window = recent.get(task.conversationId) ?? [];
				window.push(task);
				if (window.length > RECENT_TASKS_PER_CONVERSATION) {
					window.sort((a, b) => Number(b.id) - Number(a.id)).pop();
					hidden[task.conversationId] = (hidden[task.conversationId] ?? 0) + 1;
				}
				recent.set(task.conversationId, window);
			}
			cursor = page.next;
		} while (cursor);
		for (const window of recent.values()) for (const task of window) kept.set(task.id, task);
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
		for (const task of [...kept.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
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
		return { conversations, tasks, hidden };
	}, BACKGROUND_CONTEXT);
}
