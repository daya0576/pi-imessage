import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	type Cursor,
	type Harness,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import { DirectSends } from "../agent/direct-send.ts";
import { EXECUTION_KIND, Schedules } from "../agent/scheduling.ts";

function sumUsageTokens(usage: Readonly<UsageState>): number {
	let total = 0;
	for (const bucket of [usage.models, usage.tools]) {
		for (const item of Object.values(bucket)) {
			total += item.totalTokens || item.input + item.output + item.cacheRead + item.cacheWrite;
		}
	}
	return total;
}

/** Native occurrence tasks are the execution history; this view keeps no parallel log. */
export async function readSchedules(harness: Harness) {
	const { jobs, conversationsByRoot } = await harness.commit(async (tx) => {
		const schedules = await tx.doc(Schedules);
		const sends = await tx.doc(DirectSends);
		const roots = new Set(schedules.items.map((schedule) => schedule.conversationId));
		const conversationsByRoot = new Map<ConversationId, ConversationId[]>(
			schedules.items.map((schedule) => [schedule.conversationId, [schedule.conversationId]]),
		);
		if (roots.size > 0) {
			const ownerOf = new Map<ConversationId, ConversationId>();
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanConversations({}, 500, cursor);
				for (const conversation of page.items) {
					if (conversation.owner) ownerOf.set(conversation.id, conversation.owner.conversationId);
				}
				cursor = page.next;
			} while (cursor);
			for (const id of ownerOf.keys()) {
				if (roots.has(id)) continue;
				const seen = new Set<ConversationId>([id]);
				let current = ownerOf.get(id);
				while (current !== undefined && !seen.has(current)) {
					if (roots.has(current)) {
						conversationsByRoot.get(current)?.push(id);
						break;
					}
					seen.add(current);
					current = ownerOf.get(current);
				}
			}
		}
		const jobs = [];
		for (const schedule of schedules.items) {
			const task = await tx.task(schedule.taskId);
			const checkpoint = task?.state.checkpoint;
			const state =
				checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) ? checkpoint : undefined;
			// Occurrence IDs grow with admission time; the newest ten are the history shown.
			const executions = await tx.scanTasks(
				{ conversationId: schedule.conversationId, kind: EXECUTION_KIND, order: "descending" },
				10,
			);
			const runs = executions.items.map((run) => {
				const outcome = run.state.outcome;
				const result =
					outcome?.status === "completed" &&
					outcome.result &&
					typeof outcome.result === "object" &&
					!Array.isArray(outcome.result)
						? outcome.result
						: undefined;
				const receipt =
					typeof result?.requestId === "string"
						? sends.requests.find((item) => item.requestId === result.requestId)
						: undefined;
				return {
					id: run.id,
					input: run.input,
					status: outcome?.status ?? run.state.status,
					result,
					error:
						outcome?.status === "failed" || outcome?.status === "faulted" ? outcome.error.message : undefined,
					delivery: receipt?.textStatus ?? (result?.requestId ? "queued" : undefined),
				};
			});
			jobs.push({
				id: schedule.id,
				name: schedule.name,
				kind: schedule.kind,
				enabled: schedule.enabled,
				time: schedule.time,
				intervalMs: schedule.intervalMs,
				timezone: schedule.timezone,
				chatGuid: schedule.chatGuid,
				extension: schedule.extension,
				execution: schedule.execution,
				conversationId: schedule.conversationId,
				taskId: schedule.taskId,
				status: task?.state.outcome?.status ?? task?.state.status ?? "missing",
				phase: state?.phase,
				nextAt: state?.phase === "sleep" ? state.at : undefined,
				tokens: 0,
				runs,
			});
		}
		return { jobs, conversationsByRoot };
	}, BACKGROUND_CONTEXT);
	for (const job of jobs) {
		let tokens = 0;
		for (const id of conversationsByRoot.get(job.conversationId) ?? [job.conversationId]) {
			const state = await harness.snapshot(UsageDoc, id, BACKGROUND_CONTEXT);
			if (state) tokens += sumUsageTokens(state);
		}
		job.tokens = tokens;
	}
	jobs.sort((a, b) => b.tokens - a.tokens);
	return {
		jobs,
		recent: jobs
			.flatMap((job) => job.runs.map((run) => ({ ...run, jobId: job.id, name: job.name })))
			.sort((a, b) => b.id - a.id)
			.slice(0, 10),
	};
}
