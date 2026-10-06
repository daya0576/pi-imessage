import type {
	configure as Configure,
	ConversationId,
	defineDoc as DefineDoc,
	defineExtension as DefineExtension,
	defineTask as DefineTask,
	SessionDocToken,
	Tx,
} from "@earendil-works/pi-durable";
import type { EnglishFunctions, EnglishPlan, LearningHistory, LearningPolicy } from "./learning.ts";

const { readLearningHistory, planEnglish, englishPrompt, parseEnglishAnswer, applyEnglish } =
	require("./learning.ts") as EnglishFunctions;

type Context = {
	config: Record<string, unknown>;
	defineDoc: typeof DefineDoc;
	defineTask: typeof DefineTask;
	defineExtension: typeof DefineExtension;
	configure: typeof Configure;
	ScheduledOutbox: SessionDocToken<{ items: { chatGuid: string; requestId: string; text: string }[] }>;
};
type State = { phase: "start" } | { phase: "english"; conversationId: ConversationId; plan: EnglishPlan };
type Input = { jobId: string; date: string; chatGuid: string | null; resume?: State };
type Result = { summary: string; requestId?: string; finishedAt: number };

/** Business code and its policy are owned by the workspace, not the message service. */
module.exports = ({
	config,
	defineDoc,
	defineTask,
	defineExtension,
	configure,
	ScheduledOutbox,
}: Context) => {
	if (
		typeof config.enabled !== "boolean" ||
		typeof config.chatGuid !== "string" ||
		!config.chatGuid.trim() ||
		typeof config.historyFile !== "string" ||
		!config.historyFile.startsWith("/") ||
		typeof config.time !== "string" ||
		!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.time) ||
		typeof config.id !== "string" ||
		!config.id.trim()
	)
		throw new Error(
			"English configuration requires id, enabled, chatGuid, absolute historyFile and HH:MM time",
		);
	const policy = config.policy as LearningPolicy;
	if (
		!policy ||
		!Array.isArray(policy.reviewIntervals) ||
		!policy.reviewIntervals.length ||
		!policy.reviewIntervals.every((day) => Number.isSafeInteger(day) && day > 0) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(policy.effectiveFrom) ||
		![policy.maxReviews, policy.dailyLimit, policy.windowDays, policy.maxNew, policy.minNewGapDays].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
		policy.maxReviews > policy.dailyLimit
	)
		throw new Error("Invalid English learning policy");
	const historyFile = config.historyFile;
	const Learning = defineDoc<{
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
	const Card = defineTask<Input, State, Result>({
		name: "workplace-english.card",
		version: 1,
		initial: (input) => input.resume ?? { phase: "start" },
		phases: {
			async start(task, runtime, context) {
				const agent = await runtime.agent(context);
				await runtime.commit(async (tx) => {
					const learning = await tx.doc(Learning, task.conversationId);
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
					const plan = planEnglish(learning.history, task.input.date, policy);
					if (!plan.newExpression && !plan.reviews.length) {
						if (!task.input.chatGuid) throw new Error("English destination is missing");
						const text = applyEnglish(learning.history, plan, { reviews: [], newExpression: null });
						const requestId = `scheduled:${task.input.jobId}:${task.input.date}`;
						learning.cards[plan.date] = { text, requestId };
						(await tx.doc(ScheduledOutbox)).items.push({ chatGuid: task.input.chatGuid, requestId, text });
						return {
							status: "terminal",
							outcome: {
								status: "completed",
								result: { summary: "Rest day", requestId, finishedAt: runtime.now() },
							},
						};
					}
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					await configure(tx, child.id, {
						model: agent.model,
						thinkingLevel: agent.thinkingLevel,
						extensions: [],
						tools: [],
						instructions:
							"You write idiomatic spoken workplace English learning cards. Follow the JSON schema exactly.",
					});
					return { status: "running", checkpoint: { phase: "english", conversationId: child.id, plan } };
				}, context);
			},
			async english(task, runtime, context) {
				const { plan, conversationId } = task.state.checkpoint;
				const conversation = await runtime.conversation(conversationId, context);
				if (!conversation) throw new Error("English generation conversation is missing");
				const result = await (
					await conversation.submit(
						{ type: "input", content: englishPrompt(plan), requestId: `english:${task.input.date}` },
						context,
					)
				).wait(context);
				if (result.status !== "done" || result.type !== "input") throw new Error("English generation failed");
				const message = (await runtime.context(conversationId, context, result.answer)).messages.findLast(
					(item) => item.role === "assistant",
				);
				const text =
					message?.role === "assistant"
						? message.content
								.flatMap((part) => (part.type === "text" ? [part.text] : []))
								.join("\n")
								.trim()
						: "";
				const answer = parseEnglishAnswer(text, plan);
				await runtime.commit(async (tx) => {
					const learning = await tx.doc(Learning, task.conversationId);
					if (!task.input.chatGuid || !learning.history)
						throw new Error("English destination or history is missing");
					const requestId = `scheduled:${task.input.jobId}:${plan.date}`;
					if (!learning.cards[plan.date]) {
						const card = applyEnglish(learning.history, plan, answer);
						learning.cards[plan.date] = { text: card, requestId };
						(await tx.doc(ScheduledOutbox)).items.push({
							chatGuid: task.input.chatGuid,
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
	return {
		...defineExtension({ name: "workplace-english", tasks: [Card] }),
		schedules: [
			{
				id: config.id,
				name: "Workplace English",
				kind: "english",
				enabled: config.enabled,
				time: config.time,
				chatGuid: config.chatGuid,
				task: Card.definition.name,
				async initialize(tx: Tx, conversationId: ConversationId) {
					const learning = await tx.doc(Learning, conversationId);
					if (config.enabled && !learning.history)
						learning.history = await readLearningHistory(historyFile, policy);
				},
			},
		],
	};
};
