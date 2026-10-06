import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	type Task,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { ScheduledOutbox, validateSchedules, type WorkspaceExtension } from "../extensions/schedules.ts";
import type { AgentDefaults } from "./chats.ts";
import { compactChats } from "./compaction.ts";
import type { DirectSendInput, DirectSendReceipt } from "./direct-send.ts";
import { dailyTime, localDate, nextDaily } from "./time.ts";

export { ScheduledOutbox };

const SIX_HOURS = 6 * 3600000;
export const EXECUTION_KIND = "imessage.scheduled-execution";

type Schedule = {
	id: string;
	name: string;
	kind: string;
	enabled: boolean;
	intervalMs?: number;
	time?: string;
	timezone?: string;
	chatGuid?: string;
	extension?: string;
	execution?: string;
	input?: JsonValue;
	conversationId: ConversationId;
	taskId: TaskId;
	manualRuns?: Record<string, TaskId<ExecutionResult>>;
};
export const Schedules = defineDoc<{ items: Schedule[] }>({
	kind: "imessage.schedules",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

function nextAt(schedule: Schedule, previous: number, now: number) {
	if (schedule.time !== undefined) return nextDaily(schedule.time, now);
	const interval = schedule.intervalMs ?? SIX_HOURS;
	return previous + (Math.max(0, Math.floor((now - previous) / interval)) + 1) * interval;
}

type ExecutionInput = {
	jobId: string;
	dueAt: number;
	startedAt: number;
	date: string;
	/** Native migration forwards an old business checkpoint without interpreting it. */
	resume?: JsonValue;
};
type ExecutionResult = { summary: string; requestId?: string; finishedAt: number };
type ExecutionState =
	| { phase: "start" }
	| { phase: "compact"; tasks: TaskId[]; admissionFailures: number }
	| { phase: "execute"; execution: TaskId<ExecutionResult> };
type ScheduleState =
	| { phase: "sleep"; at: number }
	| { phase: "advance"; at: number; execution: TaskId<ExecutionResult> };

/** Durable owns cadence and execution receipts; extensions own business tasks and documents. */
export function schedulingExtension(harness: Harness, defaults: AgentDefaults) {
	const Execution = defineTask<ExecutionInput, ExecutionState, ExecutionResult>({
		name: EXECUTION_KIND,
		version: 2,
		initial: () => ({ phase: "start" }),
		migrate(input, checkpoint, fromVersion) {
			if (fromVersion !== 1 || !input || typeof input !== "object" || Array.isArray(input))
				throw new Error("Unsupported scheduled execution migration");
			if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint))
				throw new Error("Invalid scheduled execution checkpoint");
			const previous = input as ExecutionInput;
			if (checkpoint.phase === "start" || checkpoint.phase === "compact")
				return { input: previous, checkpoint: checkpoint as ExecutionState };
			return { input: { ...previous, resume: checkpoint }, checkpoint: { phase: "start" } };
		},
		phases: {
			async start(task, runtime, context) {
				const schedule = (await runtime.snapshot(Schedules, context))?.items.find(
					(item) => item.id === task.input.jobId,
				);
				if (!schedule) throw new Error("Scheduled job is missing");
				if (schedule.id === "compact-chats") {
					let admissionFailures = 0;
					const tasks = await compactChats(harness, () => admissionFailures++);
					await runtime.commit(
						() => ({ status: "running", checkpoint: { phase: "compact", tasks, admissionFailures } }),
						context,
					);
					return;
				}
				const definition = schedule.execution && runtime.registry.task(schedule.execution);
				if (!definition) throw new Error(`Missing scheduled task definition: ${schedule.execution}`);
				await runtime.commit(async (tx) => {
					const execution = await tx.createTask(
						definition as Task<JsonValue, { phase: string }, ExecutionResult, object>,
						{ ...task.input, config: schedule.input ?? null, chatGuid: schedule.chatGuid ?? null },
						{ ownership: { kind: "task", taskId: task.id } },
					);
					return {
						status: "waiting",
						checkpoint: { phase: "execute", execution },
						on: [execution],
						policy: "allSettled",
					};
				}, context);
			},
			async execute(task, runtime, context) {
				const receipt = await runtime.waitForTask(task.state.checkpoint.execution, context);
				await runtime.commit(() => ({ status: "terminal", outcome: receipt.state.outcome }), context);
			},
			async compact(task, runtime, context) {
				const receipts = await Promise.all(
					task.state.checkpoint.tasks.map((id) => runtime.waitForTask(id, context)),
				);
				const failed =
					task.state.checkpoint.admissionFailures +
					receipts.filter((receipt) => receipt.state.outcome.status !== "completed").length;
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: failed
							? { status: "failed", error: { message: `${failed} scheduled compaction(s) failed` } }
							: {
									status: "completed",
									result: {
										summary: `${receipts.length} native compaction(s) completed; includes no-ops`,
										finishedAt: runtime.now(),
									},
								},
					}),
					context,
				);
			},
		},
		async abort(_task, runtime, context) {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	const Scheduler = defineTask<{ jobId: string; firstAt: number }, ScheduleState, null>({
		name: "imessage.schedule",
		version: 1,
		initial: (input) => ({ phase: "sleep", at: input.firstAt }),
		phases: {
			async sleep(task, runtime, context) {
				const { at } = task.state.checkpoint;
				await runtime.sleep(at, context);
				await runtime.commit(async (tx) => {
					const schedule = (await tx.doc(Schedules)).items.find((item) => item.id === task.input.jobId);
					if (!schedule) throw new Error("Scheduled job is missing");
					const now = runtime.now();
					const beforeToday = schedule.time !== undefined && now < dailyTime(schedule.time, now);
					if (!schedule.enabled || beforeToday)
						return { status: "running", checkpoint: { phase: "sleep", at: nextAt(schedule, at, now) } };
					// A manual occurrence and a deadline share the same non-overlap boundary.
					for (const status of ["pending", "running", "waiting", "completing"] as const) {
						const existing = (
							await tx.scanTasks({ conversationId: schedule.conversationId, kind: EXECUTION_KIND, status }, 1)
						).items[0];
						if (existing)
							return {
								status: "waiting",
								checkpoint: { phase: "advance", at, execution: existing.id as TaskId<ExecutionResult> },
								on: [existing.id],
								policy: "allSettled",
							};
					}
					const execution = await tx.createTask(
						Execution,
						{ jobId: schedule.id, dueAt: at, startedAt: now, date: localDate(now) },
						{ ownership: { kind: "task", taskId: task.id } },
					);
					return {
						status: "waiting",
						checkpoint: { phase: "advance", at, execution },
						on: [execution],
						policy: "allSettled",
					};
				}, context);
			},
			async advance(task, runtime, context) {
				await runtime.commit(async (tx) => {
					const schedule = (await tx.doc(Schedules)).items.find((item) => item.id === task.input.jobId);
					if (!schedule) throw new Error("Scheduled job is missing");
					const execution = await tx.task(task.state.checkpoint.execution);
					const outcome = execution?.state.outcome;
					const result = outcome?.status === "completed" ? outcome.result : undefined;
					const finishedAt =
						result &&
						typeof result === "object" &&
						!Array.isArray(result) &&
						typeof result.finishedAt === "number"
							? result.finishedAt
							: runtime.now();
					return {
						status: "running",
						checkpoint: { phase: "sleep", at: nextAt(schedule, task.state.checkpoint.at, finishedAt) },
					};
				}, context);
			},
		},
		async abort(_task, runtime, context) {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	return {
		extension: defineExtension({ name: "scheduling", tasks: [Scheduler, Execution] }),
		async runOnce(jobId: string, requestId: string) {
			if (!jobId.trim() || !requestId.trim() || requestId.length > 200)
				throw new Error("Job and request ID are required");
			return harness.commit(async (tx) => {
				const schedule = (await tx.doc(Schedules)).items.find((item) => item.id === jobId);
				if (!schedule?.enabled) throw new Error("Scheduled job is missing or disabled");
				const existing = schedule.manualRuns?.[requestId];
				if (existing) return existing;
				for (const status of ["pending", "running", "waiting", "completing"] as const)
					if (
						(await tx.scanTasks({ conversationId: schedule.conversationId, kind: EXECUTION_KIND, status }, 1))
							.items.length
					)
						throw new Error("Scheduled job is already executing");
				const now = Date.now();
				const execution = await tx.createTask(
					Execution,
					{ jobId, dueAt: now, startedAt: now, date: localDate(now) },
					{ conversationId: schedule.conversationId, ownership: { kind: "conversation" }, background: true },
				);
				schedule.manualRuns ??= {};
				schedule.manualRuns[requestId] = execution;
				return execution;
			}, BACKGROUND_CONTEXT);
		},
		/** May join a host reload commit. Existing task IDs and absolute deadlines are never reset. */
		async initialize(extensions: readonly WorkspaceExtension[], transaction?: Tx) {
			validateSchedules(extensions);
			const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
			const initialize = async (tx: Tx) => {
				const state = await tx.doc(Schedules);
				const definitions: (Omit<Schedule, "conversationId" | "taskId"> & {
					initialize?: (tx: Tx, conversationId: ConversationId) => Promise<void>;
				})[] = [
					{
						id: "compact-chats",
						name: "Chat compaction",
						kind: "compaction",
						enabled: true,
						intervalMs: SIX_HOURS,
						timezone,
						extension: "scheduling",
					},
					...extensions.flatMap((extension) =>
						(extension.schedules ?? []).map(({ task, initialize, ...schedule }) => ({
							...schedule,
							kind: schedule.kind ?? "custom",
							extension: extension.name,
							execution: task,
							timezone,
							initialize,
						})),
					),
				];
				for (const { initialize: initializeBusiness, ...definition } of definitions) {
					const found = state.items.find((item) => item.id === definition.id);
					if (found) {
						// Clear old cadence when an extension switches between daily and interval scheduling.
						delete found.time;
						delete found.intervalMs;
						delete found.input;
						delete found.chatGuid;
						Object.assign(found, definition);
						await initializeBusiness?.(tx, found.conversationId);
						continue;
					}
					const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await configure(tx, conversation.id, { ...defaults, extensions: [], tools: [] });
					await initializeBusiness?.(tx, conversation.id);
					const firstAt =
						definition.time !== undefined
							? nextDaily(definition.time, Date.now())
							: Date.now() + (definition.intervalMs ?? SIX_HOURS);
					const taskId = await tx.createTask(
						Scheduler,
						{ jobId: definition.id, firstAt },
						{ conversationId: conversation.id, ownership: { kind: "conversation" }, background: true },
					);
					state.items.push({ ...definition, conversationId: conversation.id, taskId });
				}
				const ids = new Set(definitions.map((definition) => definition.id));
				for (const item of state.items) if (!ids.has(item.id)) item.enabled = false;
			};
			if (transaction) await initialize(transaction);
			else await harness.commit(initialize, BACKGROUND_CONTEXT);
		},
	};
}

/** Reuse at-most-once direct-send receipts; never retry unknown external effects. */
export async function deliverScheduled(
	harness: Harness,
	send: (input: DirectSendInput) => Promise<DirectSendReceipt>,
	enabled: (chatGuid: string) => boolean,
) {
	for (const item of (await harness.snapshot(ScheduledOutbox, BACKGROUND_CONTEXT))?.items ?? []) {
		if (!enabled(item.chatGuid)) continue;
		await send(item);
		await harness.commit(async (tx) => {
			const outbox = await tx.doc(ScheduledOutbox);
			outbox.items = outbox.items.filter((queued) => queued.requestId !== item.requestId);
		}, BACKGROUND_CONTEXT);
	}
}
