import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";

/** Active `/run` deadlines by conversation. In memory: a run does not survive a restart. */
export type Runs = Map<string, { deadline: number; task: string }>;

export function runExtension(runs: Runs, now = Date.now) {
	return defineExtension({
		name: "run",
		tools: [
			defineTool({
				name: "end_run",
				description: "End the active /run when its task is done or you need the user.",
				parameters: Type.Object({ reason: Type.String() }),
				replay: "safe",
				async execute(_args, api) {
					runs.delete(String(api.conversationId));
					return { content: [{ type: "text", text: "Run ended." }] };
				},
			}),
		],
		hooks: [
			hook(GenerationTask, {
				onYield(_answer, api) {
					const run = runs.get(String(api.conversationId));
					if (!run) return;
					const minutes = Math.floor((run.deadline - now()) / 60000);
					if (minutes < 1) {
						runs.delete(String(api.conversationId));
						return;
					}
					return {
						continue: `Continue the run task: ${run.task}\n${minutes} minutes left. Call end_run when the task is done or you need the user.`,
					};
				},
			}),
		],
	});
}
