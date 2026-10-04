import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { type AgentDefaults, chatConversation } from "./chats.ts";
import type { Runs } from "./run.ts";

const help = [
	"/help - list commands",
	"/new - start an empty context",
	"/stop - stop current work",
	"/status - show model and run state",
	"/compact [instructions] - compress context",
	"/thinking <level|default> - set thinking for this chat",
	"/reload - apply the default model to this chat",
	"/run <duration> [task] - keep working until done, blocked or the deadline",
	"/run-stop - end the current run",
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

/** Runs a slash command and returns the text to send back; command replies bypass the model. */
export async function runCommand(
	harness: Harness,
	defaults: () => Promise<AgentDefaults>,
	runs: Runs,
	chatGuid: string,
	text: string,
	startRun: (task: string) => Promise<void>,
) {
	const [name, ...rest] = text.trim().split(/\s+/);
	const argument = rest.join(" ");
	const conversation = await chatConversation(harness, await defaults(), chatGuid);
	const id = String(conversation.id);
	switch (name) {
		case "/help":
			return help;
		case "/stop":
		case "/new":
			runs.delete(id);
			await conversation.abort(BACKGROUND_CONTEXT);
			if (name === "/stop") return "Stopped.";
			await conversation.reset(undefined, BACKGROUND_CONTEXT);
			return "Started an empty context.";
		case "/status": {
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			const run = runs.get(id);
			return [
				`Model: ${agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "unset"}`,
				`Thinking: ${agent.thinkingLevel}`,
				`Run: ${run ? `until ${new Date(run.deadline).toISOString()}` : "none"}`,
			].join("\n");
		}
		case "/compact":
			await harness.waitForTask(
				await conversation.compact(argument || undefined, BACKGROUND_CONTEXT),
				BACKGROUND_CONTEXT,
			);
			return "Compacted.";
		case "/thinking":
			if (argument === "default") {
				await conversation.configure(
					{ thinkingLevel: (await defaults()).thinkingLevel ?? null },
					BACKGROUND_CONTEXT,
				);
				return "Thinking follows the default.";
			}
			if (!thinkingLevels.includes(argument)) return `Usage: /thinking <${thinkingLevels.join("|")}|default>`;
			await conversation.configure({ thinkingLevel: argument as ModelThinkingLevel }, BACKGROUND_CONTEXT);
			return `Thinking: ${argument} (this chat only)`;
		case "/reload": {
			const current = await defaults();
			await conversation.configure({ model: current.model }, BACKGROUND_CONTEXT);
			return `Model: ${current.model.provider}/${current.model.modelId}`;
		}
		case "/run": {
			const duration = parseDuration(rest[0] ?? "");
			if (!duration) return "Usage: /run <duration, e.g. 30m or 2h> [task]";
			if (runs.has(id)) return "A run is already active. Use /run-stop first.";
			const task = rest.slice(1).join(" ") || "Continue the current task.";
			runs.set(id, { deadline: Date.now() + duration, task });
			await startRun(task);
			return;
		}
		case "/run-stop":
			return runs.delete(id) ? "Run ended." : "No active run.";
		default:
			return `Unknown command. ${help}`;
	}
}
