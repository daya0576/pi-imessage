import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import {
	type AgentChange,
	type CompactionResult,
	type ConversationId,
	type Harness,
	LiveDoc,
	type SubmissionRecord,
	type TaskId,
	type TaskOutcome,
	UserEntry,
} from "@earendil-works/pi-durable";
import { readSettings } from "../config/settings.ts";
import {
	type AgentDefaults,
	Chats,
	chatConversation,
	interimEnabled,
	progressEnabled,
	setChatSwitch,
} from "./chats.ts";
import { activeRun, Runs, startRun } from "./run.ts";

const help = [
	"/help - list commands",
	"/new - stop current work and start an empty context",
	"/status - show messages, context usage, model and the active run",
	"/compact [instructions] - compress context",
	"/thinking <level|default> - set thinking for this chat",
	"/verbose [on|off|default] - show or set tool progress notices for this chat",
	"/interim [on|off|default] - show or set the model's messages between tool calls for this chat",
	"/reload - reload models, instructions and skills; apply the default model to this chat and show /status",
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
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
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
	closeBrowsers?: (chat: ConversationId) => Promise<void>;
	workingDir: string;
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
	// The /status report: user messages with context usage, then model with thinking (ADR 0013).
	// A third line appears only while a /run is active. Cumulative token totals are deliberately omitted.
	const status = async (withRun: boolean) => {
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const context = await conversation.context(BACKGROUND_CONTEXT);
		const window =
			agent.model && options.models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow;
		// Context size: the last reported usage, or before the first reply a local estimate of about four characters
		// per token. After /new the next request restates the system prompt and tools, so the estimate replays them
		// from the context just before the reset marker.
		const last = context.messages.findLast(
			(message) => message.role === "assistant" && message.usage.totalTokens > 0,
		);
		const estimate = async () => {
			let system = getCurrentSystemMessage(context.messages);
			if (!system && context.head) {
				const head = context.head.id;
				const before = (
					await conversation.entries({ maxEntryId: head }, 2, undefined, BACKGROUND_CONTEXT)
				).items.find((entry) => entry.id !== head);
				if (before)
					system = getCurrentSystemMessage(
						(await conversation.context(BACKGROUND_CONTEXT, { at: before.id })).messages,
					);
			}
			return context.messages
				.filter((message) => message.role !== "system")
				.reduce((sum, message) => sum + estimateTokens(message), system ? estimateTokens(system) : 0);
		};
		const used = last?.role === "assistant" ? calculateContextTokens(last.usage) : await estimate();
		const usage = `${last ? "" : "~"}${((used / (window || 1)) * 100).toFixed(1)}%`;
		return [
			[
				`${context.messages.filter((message) => message.role === "user").length} msgs`,
				window ? `${usage} / ${tokens(window)}` : "",
			]
				.filter(Boolean)
				.join(" · "),
			`${agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "unset"} · ${agent.thinkingLevel}`,
			...(withRun && run ? [`run · until ${new Date(run.deadline).toISOString()}`] : []),
		].join("\n");
	};
	switch (name) {
		case "/help":
			return { reply: help };
		case "/stop": {
			if (run) {
				await harness.abortTask(run.taskId, BACKGROUND_CONTEXT);
				await harness.waitForTask(run.taskId, BACKGROUND_CONTEXT);
				await options.closeBrowsers?.(conversation.id);
				return { reply: "Stopped." };
			}
			// Abort the generation that owns the current inputs, not the conversation, so later queued
			// messages stay in the inbox (ADR 0015). Retry while generation hands the same inputs over.
			const live = async () => (await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT))?.run;
			const stopping = await live();
			if (!stopping) {
				await options.closeBrowsers?.(conversation.id);
				return { reply: "Nothing is running." };
			}
			for (
				let current: typeof stopping | undefined = stopping;
				current?.inputs[0] === stopping.inputs[0];
				current = await live()
			) {
				await harness.abortTask(current.taskId, BACKGROUND_CONTEXT);
				await harness.waitForTask(current.taskId, BACKGROUND_CONTEXT);
			}
			await options.closeBrowsers?.(conversation.id);
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
			// The run task belongs to the chat conversation, so this abort stops it too.
			await conversation.abort(BACKGROUND_CONTEXT);
			await options.closeBrowsers?.(conversation.id);
			await conversation.reset(undefined, BACKGROUND_CONTEXT);
			return { reply: await status(false) };
		case "/status":
			return { reply: await status(true) };
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
		case "/verbose":
		case "/interim": {
			const field = name === "/verbose" ? "progress" : "interim";
			const label = name === "/verbose" ? "Verbose" : "Interim";
			if (argument && argument !== "on" && argument !== "off" && argument !== "default")
				return { reply: `Usage: ${name} [on|off|default]` };
			if (argument)
				await setChatSwitch(harness, chatGuid, field, argument === "default" ? undefined : argument === "on");
			const chats = (await harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items ?? [];
			const chat = chats.find((item) => item.chatGuid === chatGuid);
			const settings = await readSettings(options.workingDir);
			const enabled = field === "progress" ? progressEnabled : interimEnabled;
			const state = enabled(settings, chats, chatGuid) ? "on" : "off";
			if (chat?.[field] === undefined) return { reply: `${label}: ${state} (default)` };
			return { reply: `${label}: ${state} (this chat only)` };
		}
		case "/reload": {
			const current = await options.reload();
			await configure({ model: current.model });
			// Reply in the /status format so the applied model and run are visible at once.
			return { reply: await status(true) };
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
