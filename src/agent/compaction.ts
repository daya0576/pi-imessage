import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, type Harness, LiveDoc, ResetEntry, type TaskId } from "@earendil-works/pi-durable";
import { Chats } from "./chats.ts";

// Native compact() uses reason "manual" for both a command and a maintenance tick.
// Record exact timer task IDs, not conversation IDs, so concurrent manual work stays visible.
const scheduled = new WeakMap<Harness, { admissions: Set<Promise<TaskId>>; tasks: Set<TaskId> }>();

/** Resolve admission before classifying: the commit may be observed before compact() returns its ID. */
export async function takeScheduledCompaction(harness: Harness, taskId: TaskId) {
	const state = scheduled.get(harness);
	if (!state) return false;
	await Promise.allSettled([...state.admissions]);
	return state.tasks.delete(taskId);
}

/** Admit native compactions, not another summarization loop; Durable decides whether a cut is needed. */
export async function compactChats(harness: Harness, admissionFailed?: () => void) {
	const tasks: TaskId[] = [];
	const chats = await harness.snapshot(Chats, BACKGROUND_CONTEXT);
	for (const chat of chats?.items ?? []) {
		try {
			if ((await harness.snapshot(LiveDoc, chat.conversationId, BACKGROUND_CONTEXT))?.compactions?.length)
				continue;
			const conversation = await harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
			const newest = (await conversation?.entries({}, 1, undefined, BACKGROUND_CONTEXT))?.items[0];
			if (!conversation || !newest || CompactionEntry.is(newest) || ResetEntry.is(newest)) continue;
			let state = scheduled.get(harness);
			if (!state) {
				state = { admissions: new Set(), tasks: new Set() };
				scheduled.set(harness, state);
			}
			const quiet = state;
			const admission = conversation.compact(undefined, BACKGROUND_CONTEXT).then((taskId) => {
				quiet.tasks.add(taskId);
				return taskId;
			});
			quiet.admissions.add(admission);
			try {
				tasks.push(await admission);
			} finally {
				quiet.admissions.delete(admission);
			}
		} catch (error) {
			admissionFailed?.();
			console.warn("Scheduled compaction admission failed", chat.chatGuid, error);
		}
	}
	return tasks;
}
