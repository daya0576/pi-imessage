import type { AsyncQueue } from "./queue.js";
import type { ScheduledSubmission } from "./scheduler.js";
import { type Settings, isReplyEnabled } from "./settings.js";
import type { IncomingMessage } from "./types.js";

/** No retained SDK context: acceptance and its run ID share one queue receipt. */
export function createSchedulerDelivery(queue: AsyncQueue<IncomingMessage>, getSettings: () => Settings) {
	return async (task: ScheduledSubmission): Promise<void> => {
		if (!isReplyEnabled(getSettings(), task.owner)) throw new Error("Scheduled chat is no longer enabled");
		const accepted = queue.pushDurable(
			{
				chatGuid: task.owner,
				sender: `scheduler:${task.id}`,
				text: task.text,
				messageType: task.owner.includes(";+;") ? "group" : task.owner.startsWith("SMS;") ? "sms" : "imessage",
				groupName: "",
				replyToText: null,
				attachments: [],
				images: [],
			},
			`scheduled:${task.runId}`
		);
		console.log(`[scheduler] durable submission ${accepted ? "accepted" : "already accepted"}: ${task.runId}`);
	};
}
