import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { finalReplyText } from "./final-text.ts";

export const Subagent = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Run a foreground read-only subagent with a separate context. Returns its result here.",
			parameters: Type.Object({ task: Type.String() }),
			replay: "safe",
			async execute(args, api, context) {
				const parent = await api.agent(context);
				const childId = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing) return existing.id;
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					const permitted = [
						"read",
						"search_memory",
						"load_memory",
						"web_search",
						"fetch_content",
						"get_search_results",
					];
					await configure(tx, child.id, {
						extensions: { remove: [Subagent] },
						tools: parent.tools.filter((tool) => permitted.includes(tool.name)),
						instructions:
							"Complete only the delegated task. You are read-only. Do not send messages or launch background work.",
					});
					return child.id;
				}, context);
				await api.details({ conversationId: childId }, context);
				const child = await api.conversation(childId, context);
				if (!child) throw new Error("Subagent conversation missing");
				const result = await (
					await child.submit(
						{ type: "input", content: args.task, requestId: `subagent:${api.taskId}` },
						context,
					)
				).wait(context);
				if (result.status !== "done" || result.type !== "input")
					throw new Error("Subagent ended without an answer");
				const answer = await api.commit((tx) => tx.entry(result.answer), context);
				const message = answer?.model?.[0];
				return {
					content: [
						{
							type: "text",
							text: finalReplyText(message) ?? "",
						},
					],
				};
			},
		}),
	],
});
