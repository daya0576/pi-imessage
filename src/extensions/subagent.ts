import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { finalReplyText } from "./final-text.ts";

export const Subagent = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"Run a foreground subagent with a separate context and the same tools as you. Returns its result here.",
			parameters: Type.Object({ task: Type.String() }),
			replay: "safe",
			async execute(args, api, context) {
				const childId = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing) return existing.id;
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// The child has every tool its parent has, deferred ones included; only nesting another subagent is left out.
					await configure(tx, child.id, {
						extensions: { remove: [Subagent] },
						instructions:
							"Complete only the delegated task and return its result; do not take on other work.",
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
					output: [
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
