import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	hook,
	InboxDoc,
	LiveDoc,
	section,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { Deliveries, finalReplyText } from "./replies.ts";

export type RunRecord = {
	chatGuid: string;
	/** The chat conversation that started the run and keeps its record. */
	chat: ConversationId;
	/** The run's own conversation, owned by its task. */
	conversationId: ConversationId;
	taskId: TaskId;
	deadline: number;
	status: "active" | "ended";
	endReason?: string;
};

/** Every `/run`; ended runs stay listed so their last answers can still be delivered. */
export const Runs = defineDoc<{ items: RunRecord[] }>({
	kind: "imessage.runs",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

/** Model-visible notes in the chat conversation about what happened in a run. */
export const RUN_RECORD = "imessage.run-record";

export function activeRun(runs: readonly RunRecord[] | undefined, chat: ConversationId) {
	return runs?.find((run) => run.chat === chat && run.status === "active");
}

export function runRecord(text: string, now: number) {
	return { kind: RUN_RECORD, model: [{ role: "user" as const, content: text, timestamp: now }] };
}

const instructions = [
	"This conversation is a /run: the user asked you to keep working on the task without waiting for confirmation.",
	"Every final answer is sent to the chat as it is written.",
	"Call end_run when the task is done, when you need the user, or when there is no unfinished task; do not invent a new task.",
].join("\n");

async function finish(tx: Tx, taskId: TaskId, stopped: boolean, now: number) {
	const run = (await tx.doc(Runs)).items.find((item) => item.taskId === taskId);
	if (!run || run.status === "ended") return;
	if (stopped) {
		// Withdraw answers that were not claimed for sending; a claimed send cannot be retracted.
		const deliveries = await tx.doc(Deliveries, run.conversationId);
		const entries = await tx.scanEntries(
			{
				conversationId: run.conversationId,
				...(deliveries.scanned === undefined ? {} : { minEntryId: deliveries.scanned }),
			},
			1000,
		);
		for (const entry of entries.items) {
			const key = String(entry.id);
			if (!AssistantEntry.is(entry) || !finalReplyText(entry.model?.[0]) || deliveries.answers[key]) continue;
			if (deliveries.drafts?.[key] && deliveries.drafts[key].status !== "held") continue;
			deliveries.drafts ??= {};
			deliveries.drafts[key] = { status: "cancelled" };
		}
		const drafts = deliveries.drafts ?? {};
		for (const [key, draft] of Object.entries(drafts))
			if (draft.status === "held") drafts[key] = { status: "cancelled" };
		run.endReason = "stopped";
	}
	run.endReason ??= now >= run.deadline ? "deadline" : "finished";
	run.status = "ended";
	// The chat conversation is idle while its run is active: ordinary messages go to the run.
	await tx.appendEntry(run.chat, runRecord(`[/run ended: ${run.endReason}]`, now));
}

type RunState = { phase: "start" } | { phase: "watch" };

/** Owns the run conversation, so aborting it stops the run's work and withdraws its queued messages. */
export const RunTask = defineTask<{ task: string }, RunState, null>({
	name: "imessage.run",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		async start(task, runtime, context) {
			const run = (await runtime.snapshot(Runs, context))?.items.find((item) => item.taskId === task.id);
			const conversation = run && (await runtime.conversation(run.conversationId, context));
			if (!conversation) throw new Error("Run conversation is missing");
			await conversation.submit(
				{ type: "input", content: task.input.task, requestId: `run:${task.id}`, whenBusy: "steer" },
				context,
			);
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "watch" } }), context);
		},
		async watch(task, runtime, context) {
			const run = (await runtime.snapshot(Runs, context))?.items.find((item) => item.taskId === task.id);
			const conversation = run && (await runtime.conversation(run.conversationId, context));
			// onYield keeps the run conversation busy until end_run or the deadline; idle means the run is over.
			await conversation?.waitForIdle(context);
			await runtime.commit(async (tx) => {
				await finish(tx, task.id, false, runtime.now());
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	async abort(task, runtime, context) {
		await runtime.commit(async (tx) => {
			await finish(tx, task.id, true, runtime.now());
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** Selected only by run conversations; its task definition resolves everywhere. */
export const RunExtension = defineExtension({
	name: "run",
	tasks: [RunTask],
	sections: [section("run", () => instructions)],
	tools: [
		defineTool({
			name: "end_run",
			description: "End this /run when the task is done, you need the user, or nothing is left to do.",
			parameters: Type.Object({ reason: Type.String() }),
			replay: "safe",
			async execute(args, api, context) {
				await api.commit(async (tx) => {
					const run = (await tx.doc(Runs)).items.find(
						(item) => item.conversationId === api.conversationId && item.status === "active",
					);
					if (run) run.endReason = args.reason;
				}, context);
				return { content: [{ type: "text", text: "The run ends after this answer." }] };
			},
		}),
	],
	hooks: [
		hook(GenerationTask, {
			async onYield(_answer, api, context) {
				const run = (await api.snapshot(Runs, context))?.items.find(
					(item) => item.conversationId === api.conversationId,
				);
				if (run?.status !== "active" || run.endReason !== undefined) return;
				// The deadline only stops continuation; a turn in progress finishes.
				const minutes = Math.floor((run.deadline - Date.now()) / 60000);
				if (minutes < 1) return;
				return {
					continue: `Continue the /run task. ${minutes} minutes left. Call end_run when it is done or you need the user.`,
				};
			},
		}),
	],
});

/** Starts a run in a fork of the idle chat conversation, or moves the deadline of the active one. */
export function startRun(chat: Conversation, chatGuid: string, deadline: number, task: string) {
	return chat.commit(async (tx) => {
		const newest = (await tx.scanEntries({ conversationId: chat.id }, 1)).items[0];
		const runs = await tx.doc(Runs);
		const active = activeRun(runs.items, chat.id);
		if (active) {
			active.deadline = deadline;
			return { status: "updated", run: { ...active } } as const;
		}
		const inbox = await tx.doc(InboxDoc, chat.id);
		if ((await tx.doc(LiveDoc, chat.id)).run || inbox.items.length > 0) return { status: "busy" } as const;
		const taskId = await tx.createTask(RunTask, { task }, { ownership: { kind: "conversation" } });
		const ownership = { ownership: { kind: "task", taskId } } as const;
		// A fork inherits the chat's context without copying or summarizing it.
		const conversation = newest
			? await tx.forkConversation(chat.id, newest.id, ownership)
			: await tx.createConversation(ownership);
		await configure(tx, conversation.id, { extensions: { add: [RunExtension] } });
		const run: RunRecord = {
			chatGuid,
			chat: chat.id,
			conversationId: conversation.id,
			taskId,
			deadline,
			status: "active",
		};
		runs.items.push(run);
		await tx.appendEntry(chat.id, runRecord(`[/run started: ${task}]`, Date.now()));
		return { status: "started", run: { ...run } } as const;
	}, BACKGROUND_CONTEXT);
}
