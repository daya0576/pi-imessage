import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, type Harness, LiveDoc, ResetEntry, type TaskId } from "@earendil-works/pi-durable";
import { Chats } from "./chats.ts";

/** Admit native compactions, not another summarization loop; Durable decides whether a cut is needed. */
export async function compactChats(harness: Harness) {
	const tasks: TaskId[] = [];
	const chats = await harness.snapshot(Chats, BACKGROUND_CONTEXT);
	for (const chat of chats?.items ?? []) {
		try {
			if ((await harness.snapshot(LiveDoc, chat.conversationId, BACKGROUND_CONTEXT))?.compactions?.length)
				continue;
			const conversation = await harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
			const newest = (await conversation?.entries({}, 1, undefined, BACKGROUND_CONTEXT))?.items[0];
			if (!conversation || !newest || CompactionEntry.is(newest) || ResetEntry.is(newest)) continue;
			tasks.push(await conversation.compact(undefined, BACKGROUND_CONTEXT));
		} catch (error) {
			console.warn("Scheduled compaction admission failed", chat.chatGuid, error);
		}
	}
	return tasks;
}
