import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { CommitPublication, Harness } from "@earendil-works/pi-durable";

const REASON_LIMIT = 200;

const failedAssistant = (message: Message): message is AssistantMessage =>
	message.role === "assistant" && message.stopReason === "error";

/**
 * Service-log error lines for failures that break normal operation (ADR 0053). Durable keeps a failed
 * task only in its records, so without this an exhausted provider quota leaves stdout silent while the
 * process, port and HTTP checks look healthy. Each error kind is one branch here; the first is a model
 * call that ends failed, which leaves the chat or scheduled job without the answer it was waiting for.
 */
export function logErrors(harness: Harness) {
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
			console.error(new Date().toISOString(), "Model call failed", {
				kind: task.kind,
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
