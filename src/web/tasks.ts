import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationRecord,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Harness,
	type TaskId,
	type TaskRecord,
	UserEntry,
} from "@earendil-works/pi-durable";
import { displayHistory, historyActivity } from "./history.ts";

/** Newest generations shown per conversation, with every entry and task from the turn of the oldest one. */
export const RECENT_GENERATIONS_PER_CONVERSATION = 10;
/** Newest tasks shown for a conversation that never generated (schedulers). */
export const RECENT_TASKS_PER_CONVERSATION = 20;
/** Pages of 5 entries read back from the oldest generation to find the user message that opened its turn. */
const TURN_LOOKBACK_PAGES = 4;

type Summary = TaskRecord<unknown, unknown, unknown>;

function firstLine(text: string, limit = 80) {
	return text
		.replace(/^\[(?:Group '[^']*'|DM|SMS) from [^\]]+\] /, "")
		.split("\n")
		.find((line) => line.trim())
		?.trim()
		.slice(0, limit);
}

/** One line per entry: the first user or assistant message, tool calls by name only, tool results by text. */
function summarizeEntry(entry: EntryRecord) {
	const message = entry.model?.[0];
	if (!message) return { role: undefined, text: undefined };
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: content
					.map((block) =>
						block.type === "text"
							? block.text
							: block.type === "toolCall"
								? `[toolCall ${block.name}]`
								: block.type === "thinking"
									? "[thinking]"
									: `[${block.type}]`,
					)
					.filter(Boolean)
					.join(" ");
	return { role: message.role, text: firstLine(text) };
}

/**
 * Read one consistent tree, newest first: all conversations, every unfinished task, every task that owns a
 * conversation and their parent chains. Per conversation the window is the newest generations plus every
 * entry and task back to the `pi.user` entry that opened the oldest one's turn. Entries and tasks share one
 * id sequence, so the window is a plain id range and the browser nests records by `owner` and `byTaskId`
 * without any inference. Descending scans stop at the window instead of reading the whole history
 * (earendil-works/pi#10546).
 */
export function readTaskTree(harness: Harness) {
	return harness.commit(async (tx) => {
		const conversations: (ConversationRecord & { updatedAt: number; groupName?: string })[] = [];
		const kept = new Map<TaskId, Summary>();
		const entries: {
			id: EntryId;
			conversationId: ConversationRecord["id"];
			kind: string;
			byTaskId: TaskId | undefined;
			role: string | undefined;
			text: string | undefined;
		}[] = [];
		const more: Record<string, true> = {};
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 100, cursor);
			for (const conversation of page.items) {
				const id = conversation.id;
				// One descending scan: the newest tasks down to the oldest shown generation; a task scan with a
				// conversation filter walks the global task order, so it must not run twice per conversation.
				const recent: Summary[] = [];
				let oldest: Summary | undefined;
				let generations = 0;
				let next: Cursor | undefined;
				scan: do {
					const tasks = await tx.scanTasks({ conversationId: id, order: "descending" }, 100, next);
					for (const task of tasks.items) {
						if (task.kind === "pi.generation") {
							if (++generations > RECENT_GENERATIONS_PER_CONVERSATION) {
								more[id] = true;
								break scan;
							}
							oldest = task;
						} else if (!generations && recent.length >= RECENT_TASKS_PER_CONVERSATION) {
							more[id] = true;
							break scan;
						}
						recent.push(task);
					}
					next = tasks.next;
				} while (next);
				let history: EntryRecord[];
				let floor: number;
				if (oldest) {
					history = [];
					let next: Cursor | undefined;
					do {
						const window = await tx.scanEntries(
							{ conversationId: id, minEntryId: oldest.id as number as EntryId },
							100,
							next,
						);
						history.push(...window.items);
						next = window.next;
					} while (next);
					// Walk back to the user message that opened the oldest generation's turn.
					let max = (oldest.id as number) - 1;
					for (let pages = 0; pages < TURN_LOOKBACK_PAGES; pages++) {
						const older = await tx.scanEntries({ conversationId: id, maxEntryId: max as EntryId }, 5);
						const user = older.items.findIndex((entry) => UserEntry.is(entry));
						history.push(...(user === -1 ? older.items : older.items.slice(0, user + 1)));
						if (user !== -1 || !older.items.length) break;
						max = (older.items[older.items.length - 1].id as number) - 1;
					}
					const turn = history.find((entry) => UserEntry.is(entry) && entry.id < oldest.id);
					floor = turn ? turn.id : oldest.id;
					history = history.filter((entry) => entry.id >= floor);
					// Tasks between the turn's user message and its first generation sit on the next page.
					while (next && (recent.at(-1)?.id ?? 0) >= floor) {
						const tasks = await tx.scanTasks({ conversationId: id, order: "descending" }, 100, next);
						recent.push(...tasks.items.filter((task) => task.id >= floor));
						next = tasks.next;
					}
				} else {
					// Names and activity still come from the newest 100 entries, as on the Messages page.
					history = [...(await tx.scanEntries({ conversationId: id }, 100)).items];
					floor = history[RECENT_TASKS_PER_CONVERSATION - 1]?.id ?? 0;
				}
				const page = { items: history, next: undefined };
				const { groupName } = displayHistory(page, 1);
				conversations.push({
					...conversation,
					updatedAt: historyActivity(page),
					groupName: typeof groupName === "string" ? groupName : undefined,
				});
				for (const entry of history) {
					if (entry.id < floor) continue;
					entries.push({
						id: entry.id,
						conversationId: id,
						kind: entry.kind,
						byTaskId: entry.byTaskId,
						...summarizeEntry(entry),
					});
				}
				for (const task of recent) if (!oldest || task.id >= floor) kept.set(task.id, task);
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
				// Phases exist only while a task runs; a terminal record keeps its outcome and drops the checkpoint.
				phase:
					state.checkpoint && typeof state.checkpoint === "object" && !Array.isArray(state.checkpoint)
						? (state.checkpoint as { phase?: unknown }).phase
						: undefined,
				on: state.status === "waiting" ? state.on : undefined,
				until: state.status === "sleeping" ? state.until : undefined,
				outcome: state.outcome?.status,
			});
		}
		return { conversations, tasks, entries, more };
	}, BACKGROUND_CONTEXT);
}
