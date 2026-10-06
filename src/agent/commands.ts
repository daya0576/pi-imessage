import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentChange,
	type CompactionResult,
	type Harness,
	LiveDoc,
	type SubmissionRecord,
	type TaskId,
	type TaskOutcome,
	UsageDoc,
	UserEntry,
} from "@earendil-works/pi-durable";
import { type AgentDefaults, chatConversation } from "./chats.ts";
import { activeRun, Runs, startRun } from "./run.ts";

const help = [
	"/help - list commands",
	"/new - stop current work and start an empty context",
	"/status - show messages, tokens, context usage, model and run",
	"/compact [instructions] - compress context",
	"/thinking <level|default> - set thinking for this chat",
	"/reload - reload models, instructions and skills; apply the default model to this chat",
	"/run <duration> [task] - keep working until done, blocked or the deadline, e.g. /run 1h",
	"/stop - stop the current work or /run",
].join("\n");
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function isCommand(text: string) {
	return text.trimStart().startsWith("/");
}

export function parseDuration(value: string) {
	const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(value);
	if (!match || (!match[1] && !match[2])) return;
	return (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60000;
}

function tokens(count: number) {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** A compaction runs independently; its reply follows the native task/placement outcome. */
export type CommandResult = { reply?: string; wait?: TaskId<CompactionResult> };

export function compactionReply(outcome: TaskOutcome<CompactionResult>, placement?: SubmissionRecord) {
	if (outcome.status === "aborted") return "Compaction cancelled.";
	if (outcome.status !== "completed") return "Compaction failed.";
	if (outcome.result.entryId !== undefined) return "Compacted.";
	if (outcome.result.submissionId === undefined) return "Nothing to compact.";
	if (placement?.type !== "write") return "Compaction result unavailable.";
	if (placement.status === "done") return "Compacted.";
	if (placement.status === "queued") return "Compaction summary queued for the next turn boundary.";
	return placement.reason === "stale"
		? "Compaction summary discarded because the context changed."
		: "Compaction summary was not applied.";
}

/** Runs a slash command through Durable APIs; command replies bypass the model. */
export async function runCommand(options: {
	harness: Harness;
	models: Models;
	defaults: AgentDefaults;
	reload: () => Promise<AgentDefaults>;
	chatGuid: string;
	guid: string;
	text: string;
}): Promise<CommandResult> {
	const { harness, chatGuid } = options;
	const [name, ...rest] = options.text.trim().split(/\s+/);
	const argument = rest.join(" ");
	const conversation = await chatConversation(harness, options.defaults, chatGuid);
	const run = activeRun((await harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items, conversation.id);
	// Agent settings apply to the chat and to its active run.
	const configure = async (change: AgentChange) => {
		await conversation.configure(change, BACKGROUND_CONTEXT);
		if (run)
			await (await harness.conversation(run.conversationId, BACKGROUND_CONTEXT))?.configure(
				change,
				BACKGROUND_CONTEXT,
			);
	};
	switch (name) {
		case "/help":
			return { reply: help };
		case "/stop": {
			if (run) {
				await harness.abortTask(run.taskId, BACKGROUND_CONTEXT);
				await harness.waitForTask(run.taskId, BACKGROUND_CONTEXT);
				return { reply: "Stopped." };
			}
			// Abort the generation that owns the current inputs, not the conversation, so later queued
			// messages stay in the inbox (ADR 0015). Retry while generation hands the same inputs over.
			const live = async () => (await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT))?.run;
			const stopping = await live();
			if (!stopping) return { reply: "Nothing is running." };
			for (
				let current: typeof stopping | undefined = stopping;
				current?.inputs[0] === stopping.inputs[0];
				current = await live()
			) {
				await harness.abortTask(current.taskId, BACKGROUND_CONTEXT);
				await harness.waitForTask(current.taskId, BACKGROUND_CONTEXT);
			}
			// A passive note gives Durable a boundary to place the queued messages.
			await conversation.submit(
				{
					type: "write",
					entry: {
						kind: UserEntry.kind,
						model: [{ role: "user", content: "[/stop]", timestamp: Date.now() }],
					},
				},
				BACKGROUND_CONTEXT,
			);
			return { reply: "Stopped." };
		}
		case "/new":
		case "/status": {
			if (name === "/new") {
				// The run task belongs to the chat conversation, so this abort stops it too.
				await conversation.abort(BACKGROUND_CONTEXT);
				await conversation.reset(undefined, BACKGROUND_CONTEXT);
			}
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			const context = await conversation.context(BACKGROUND_CONTEXT);
			const usage = Object.values(
				(await harness.snapshot(UsageDoc, conversation.id, BACKGROUND_CONTEXT))?.models ?? {},
			);
			const last = context.messages.findLast(
				(message) => message.role === "assistant" && message.usage.totalTokens > 0,
			);
			const window =
				agent.model && options.models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow;
			const used = last?.role === "assistant" ? last.usage.totalTokens : undefined;
			return {
				reply: [
					[
						`${context.messages.filter((message) => message.role === "user").length} msgs -`,
						`in ${tokens(usage.reduce((sum, item) => sum + item.input, 0))}`,
						`out ${tokens(usage.reduce((sum, item) => sum + item.output, 0))}`,
						window
							? `${used === undefined ? "?" : `${((used / window) * 100).toFixed(1)}%`}/${tokens(window)}`
							: "",
					]
						.join(" ")
						.trim(),
					`Model: ${agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "unset"}, thinking: ${agent.thinkingLevel}`,
					...(name === "/status"
						? [`Run: ${run ? `until ${new Date(run.deadline).toISOString()}` : "none"}`]
						: []),
				].join("\n"),
			};
		}
		case "/compact":
			return {
				wait: await conversation.compact(argument || undefined, BACKGROUND_CONTEXT),
			};
		case "/thinking":
			if (argument === "default") {
				await configure({ thinkingLevel: options.defaults.thinkingLevel ?? null });
				return { reply: "Thinking follows the default." };
			}
			if (!thinkingLevels.includes(argument))
				return { reply: `Usage: /thinking <${thinkingLevels.join("|")}|default>` };
			await configure({ thinkingLevel: argument as ModelThinkingLevel });
			return { reply: `Thinking: ${argument} (this chat only)` };
		case "/reload": {
			const current = await options.reload();
			await configure({ model: current.model });
			return { reply: `Reloaded. Model: ${current.model.provider}/${current.model.modelId}` };
		}
		case "/run": {
			const duration = parseDuration(rest[0] ?? "");
			if (!duration) return { reply: "Usage: /run <duration, e.g. 30m or 2h> [task]" };
			const task = rest.slice(1).join(" ");
			const started = await startRun(
				conversation,
				chatGuid,
				Date.now() + duration,
				task || "Continue the current task.",
			);
			if (started.status === "busy") return { reply: "Busy. Send /run again when the current work is done." };
			if (started.status === "started") return {};
			if (task) {
				const target = await harness.conversation(started.run.conversationId, BACKGROUND_CONTEXT);
				await target?.submit(
					{ type: "input", content: task, requestId: options.guid, whenBusy: "steer" },
					BACKGROUND_CONTEXT,
				);
			}
			return { reply: `Run extended until ${new Date(started.run.deadline).toISOString()}.` };
		}
		default:
			return { reply: `Unknown command.\n${help}` };
	}
}
