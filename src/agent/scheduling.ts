import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	type TaskId,
} from "@earendil-works/pi-durable";
import type { Settings } from "../config/settings.ts";
import { finalReplyText } from "../extensions/final-text.ts";
import type { AgentDefaults } from "./chats.ts";
import { compactChats } from "./compaction.ts";
import type { DirectSendInput, DirectSendReceipt } from "./direct-send.ts";
import {
	applyEnglish,
	type EnglishPlan,
	englishPrompt,
	type LearningHistory,
	parseEnglishAnswer,
	planEnglish,
	readLearningHistory,
} from "./english.ts";
import { dailyTime, localDate, nextDaily } from "./time.ts";

const SIX_HOURS = 6 * 3600000;
export const EXECUTION_KIND = "imessage.scheduled-execution";

type Schedule = {
	id: string;
	name: string;
	kind: "compaction" | "english";
	enabled: boolean;
	intervalMs?: number;
	time?: string;
	timezone?: string;
	chatGuid?: string;
	historyFile?: string;
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
export const EnglishLearning = defineDoc<{
	history?: LearningHistory;
	cards: Record<string, { text: string; requestId: string }>;
}>({
	kind: "imessage.english-learning",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cards: {} }),
});
export const ScheduledOutbox = defineDoc<{
	items: { chatGuid: string; requestId: string; text: string }[];
}>({
	kind: "imessage.scheduled-outbox",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

function nextAt(schedule: Schedule, previous: number, now: number) {
	if (schedule.kind === "english") return nextDaily(schedule.time ?? "07:45", now);
	const interval = schedule.intervalMs ?? SIX_HOURS;
	return previous + (Math.max(0, Math.floor((now - previous) / interval)) + 1) * interval;
}

type ExecutionInput = { jobId: string; dueAt: number; startedAt: number; date: string };
type ExecutionResult = { summary: string; requestId?: string; finishedAt: number };
type ExecutionState =
	| { phase: "start" }
	| { phase: "compact"; tasks: TaskId[]; admissionFailures: number }
	| { phase: "english"; conversationId: ConversationId; plan: EnglishPlan };
type ScheduleState =
	| { phase: "sleep"; at: number }
	| { phase: "advance"; at: number; execution: TaskId<ExecutionResult> };

/** Definitions live in the product agent layer because maintenance depends on chat routing. */
export function schedulingExtension(harness: Harness, defaults: AgentDefaults) {
	const Execution = defineTask<ExecutionInput, ExecutionState, ExecutionResult>({
		name: EXECUTION_KIND,
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			async start(task, runtime, context) {
				const schedule = (await runtime.snapshot(Schedules, context))?.items.find(
					(item) => item.id === task.input.jobId,
				);
				if (!schedule) throw new Error("Scheduled job is missing");
				if (schedule.kind === "compaction") {
					let admissionFailures = 0;
					const tasks = await compactChats(harness, () => {
						admissionFailures++;
					});
					await runtime.commit(
						() => ({ status: "running", checkpoint: { phase: "compact", tasks, admissionFailures } }),
						context,
					);
					return;
				}
				await runtime.commit(async (tx) => {
					const learning = await tx.doc(EnglishLearning, task.conversationId);
					const card = learning.cards[task.input.date];
					if (card)
						return {
							status: "terminal",
							outcome: {
								status: "completed",
								result: {
									summary: "Today's card already exists",
									requestId: card.requestId,
									finishedAt: runtime.now(),
								},
							},
						};
					if (!learning.history) throw new Error("English learning history is unavailable");
					const plan = planEnglish(learning.history, task.input.date);
					if (!plan.newExpression && !plan.reviews.length) {
						const text = applyEnglish(learning.history, plan, { reviews: [], newExpression: null });
						const requestId = `scheduled:${schedule.id}:${task.input.date}`;
						learning.cards[plan.date] = { text, requestId };
						(await tx.doc(ScheduledOutbox)).items.push({
							chatGuid: schedule.chatGuid ?? "",
							requestId,
							text,
						});
						return {
							status: "terminal",
							outcome: {
								status: "completed",
								result: {
									summary: "Rest day",
									requestId,
									finishedAt: runtime.now(),
								},
							},
						};
					}
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					await configure(tx, child.id, {
						...defaults,
						extensions: [],
						tools: [],
						instructions:
							"You write idiomatic spoken workplace English learning cards. Follow the JSON schema exactly.",
					});
					return { status: "running", checkpoint: { phase: "english", conversationId: child.id, plan } };
				}, context);
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
			async english(task, runtime, context) {
				const { plan, conversationId } = task.state.checkpoint;
				const conversation = await runtime.conversation(conversationId, context);
				if (!conversation) throw new Error("English generation conversation is missing");
				const result = await (
					await conversation.submit(
						{
							type: "input",
							content: englishPrompt(plan),
							requestId: `english:${task.input.date}`,
						},
						context,
					)
				).wait(context);
				if (result.status !== "done" || result.type !== "input") throw new Error("English generation failed");
				const answerEntry = await harness.commit((tx) => tx.entry(result.answer), context);
				const text = finalReplyText(answerEntry?.model?.[0]);
				const answer = parseEnglishAnswer(text ?? "", plan);
				await runtime.commit(async (tx) => {
					const schedule = (await tx.doc(Schedules)).items.find((item) => item.id === task.input.jobId);
					const learning = await tx.doc(EnglishLearning, task.conversationId);
					if (!schedule?.chatGuid || !learning.history)
						throw new Error("English schedule or history is missing");
					const requestId = `scheduled:${schedule.id}:${plan.date}`;
					if (!learning.cards[plan.date]) {
						const card = applyEnglish(learning.history, plan, answer);
						learning.cards[plan.date] = { text: card, requestId };
						(await tx.doc(ScheduledOutbox)).items.push({
							chatGuid: schedule.chatGuid,
							requestId,
							text: card,
						});
					}
					return {
						status: "terminal",
						outcome: {
							status: "completed",
							result: {
								summary: `${plan.reviews.length} review(s), ${answer.newExpression ? 1 : 0} new expression`,
								requestId,
								finishedAt: runtime.now(),
							},
						},
					};
				}, context);
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
					// No backfill before today's daily slot. After that slot, process only today.
					const beforeToday = schedule.kind === "english" && now < dailyTime(schedule.time ?? "07:45", now);
					if (!schedule.enabled || beforeToday)
						return {
							status: "running",
							checkpoint: { phase: "sleep", at: nextAt(schedule, at, now) },
						};
					const execution = await tx.createTask(
						Execution,
						{
							jobId: schedule.id,
							dueAt: at,
							startedAt: now,
							date: localDate(now),
						},
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
						checkpoint: {
							phase: "sleep",
							at: nextAt(schedule, task.state.checkpoint.at, finishedAt),
						},
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
		/** Operator-only admission inside the existing storage owner; never opens a second writer. */
		async runOnce(jobId: string, requestId: string) {
			if (!jobId.trim() || !requestId.trim() || requestId.length > 200)
				throw new Error("Job and request ID are required");
			return harness.commit(async (tx) => {
				const schedule = (await tx.doc(Schedules)).items.find((item) => item.id === jobId);
				if (!schedule?.enabled) throw new Error("Scheduled job is missing or disabled");
				const existing = schedule.manualRuns?.[requestId];
				if (existing) return existing;
				for (const status of ["pending", "running", "waiting", "completing"] as const) {
					if (
						(await tx.scanTasks({ conversationId: schedule.conversationId, kind: EXECUTION_KIND, status }, 1))
							.items.length
					)
						throw new Error("Scheduled job is already executing");
				}
				const now = Date.now();
				const execution = await tx.createTask(
					Execution,
					{ jobId, dueAt: now, startedAt: now, date: localDate(now) },
					{
						conversationId: schedule.conversationId,
						ownership: { kind: "conversation" },
						background: true,
					},
				);
				schedule.manualRuns ??= {};
				schedule.manualRuns[requestId] = execution;
				return execution;
			}, BACKGROUND_CONTEXT);
		},
		async initialize(settings: Settings) {
			const english = settings.scheduledEnglish;
			const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
			const existing = (await harness.snapshot(Schedules, BACKGROUND_CONTEXT))?.items;
			const previousEnglish = existing?.find((item) => item.kind === "english");
			const learning =
				previousEnglish &&
				(await harness.snapshot(EnglishLearning, previousEnglish.conversationId, BACKGROUND_CONTEXT));
			const imported =
				english?.enabled && !learning?.history ? await readLearningHistory(english.historyFile) : undefined;
			await harness.commit(async (tx) => {
				const state = await tx.doc(Schedules);
				const definitions: Omit<Schedule, "conversationId" | "taskId">[] = [
					{
						id: "compact-chats",
						name: "Chat compaction",
						kind: "compaction",
						enabled: true,
						intervalMs: SIX_HOURS,
						timezone,
					},
				];
				if (english)
					definitions.push({
						id: "henry-work-english-expressions",
						name: "Workplace English",
						kind: "english",
						...english,
						timezone,
					});
				for (const definition of definitions) {
					const found = state.items.find((item) => item.id === definition.id);
					if (found) {
						Object.assign(found, definition);
						if (imported) (await tx.doc(EnglishLearning, found.conversationId)).history ??= imported;
						continue;
					}
					const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await configure(tx, conversation.id, { ...defaults, extensions: [], tools: [] });
					const firstAt =
						definition.kind === "english"
							? nextDaily(definition.time ?? "07:45", Date.now())
							: Date.now() + SIX_HOURS;
					const taskId = await tx.createTask(
						Scheduler,
						{ jobId: definition.id, firstAt },
						{
							conversationId: conversation.id,
							ownership: { kind: "conversation" },
							background: true,
						},
					);
					state.items.push({ ...definition, conversationId: conversation.id, taskId });
					if (imported && definition.kind === "english")
						(await tx.doc(EnglishLearning, conversation.id)).history = imported;
				}
				// Removing the setting disables only our native job, never touches retained legacy jobs.
				if (!english) for (const item of state.items) if (item.kind === "english") item.enabled = false;
			}, BACKGROUND_CONTEXT);
		},
	};
}

/** Reuse the existing at-most-once immediate-send receipts; never retry unknown external effects. */
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
