import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor, Harness } from "@earendil-works/pi-durable";
import { DirectSends } from "../agent/direct-send.ts";
import { EXECUTION_KIND, Schedules } from "../agent/scheduling.ts";

/** Native occurrence tasks are the execution history; this view keeps no parallel log. */
export function readSchedules(harness: Harness) {
	return harness.commit(async (tx) => {
		const schedules = await tx.doc(Schedules);
		const sends = await tx.doc(DirectSends);
		const jobs = [];
		for (const schedule of schedules.items) {
			const task = await tx.task(schedule.taskId);
			const checkpoint = task?.state.checkpoint;
			const state =
				checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) ? checkpoint : undefined;
			const executions = [];
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanTasks(
					{ conversationId: schedule.conversationId, kind: EXECUTION_KIND },
					100,
					cursor,
				);
				executions.push(...page.items);
				cursor = page.next;
			} while (cursor);
			// Native scans merge live/terminal records; their order is not execution chronology.
			const runs = executions
				.sort((a, b) => b.id - a.id)
				.slice(0, 10)
				.map((run) => {
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
							outcome?.status === "failed" || outcome?.status === "faulted"
								? outcome.error.message
								: undefined,
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
				runs,
			});
		}
		return {
			jobs,
			recent: jobs
				.flatMap((job) => job.runs.map((run) => ({ ...run, jobId: job.id, name: job.name })))
				.sort((a, b) => b.id - a.id)
				.slice(0, 10),
		};
	}, BACKGROUND_CONTEXT);
}
