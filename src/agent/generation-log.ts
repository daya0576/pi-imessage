import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { CommitPublication, Harness } from "@earendil-works/pi-durable";

const REASON_LIMIT = 200;

const failedAssistant = (message: Message): message is AssistantMessage =>
	message.role === "assistant" && message.stopReason === "error";

/**
 * Write every failed model generation to the service log. Durable keeps the error only in records,
 * so without this a provider outage or exhausted quota leaves stdout silent while the host looks healthy.
 */
export function logGenerationFailures(harness: Harness) {
	return harness.subscribeCommits(({ changes }: CommitPublication) => {
		for (const change of changes) {
			if (change.type !== "task" || change.value.kind !== "pi.generation") continue;
			const task = change.value;
			if (task.state.status !== "terminal") continue;
			const { outcome } = task.state;
			if (outcome.status === "completed" || outcome.status === "aborted") continue;
			// The failing assistant message is committed together with the task and names provider and model.
			const failed = changes
				.flatMap((item) =>
					item.type === "entry" && item.value.conversationId === task.conversationId
						? (item.value.model ?? [])
						: [],
				)
				.find(failedAssistant);
			console.warn(new Date().toISOString(), "Generation failed", {
				task: task.id,
				conversation: task.conversationId,
				status: outcome.status,
				provider: failed?.provider,
				model: failed?.model,
				reason: (outcome.error?.message ?? outcome.reason ?? "").slice(0, REASON_LIMIT),
			});
		}
	});
}
