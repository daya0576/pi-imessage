import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export function scheduleExtension(clock: {
	owner(id: ConversationId): Promise<string>;
	schedule(
		owner: string,
		when: string,
		prompt: string,
		every: string | undefined,
		requestId: string,
	): unknown;
	list(owner: string): unknown;
	cancel(owner: string, id: string): unknown;
	watch(owner: string, input: { completionFile: string; instruction: string; waitMinutes?: number }): unknown;
	send(input: { chatGuid: string; requestId: string; text?: string; filePath?: string }): Promise<unknown>;
}) {
	const owner = async (id: ConversationId, context: Context) => {
		const destination = await clock.owner(id);
		context.abortSignal?.throwIfAborted();
		return destination;
	};
	return defineExtension({
		name: "service-scheduler",
		sections: [
			section(
				"scheduler",
				() =>
					"Use send_message to send a file, or a message outside your final answer; your final answer is sent automatically. Use schedule_task for delayed or repeating work and cancel_scheduled_task when its explicit stop condition is met. Register watch_background BEFORE launching a detached command, with a fresh run-specific completion JSON. The command must atomically publish a terminal success/failure status; the watcher only reads results and never reruns the command.",
			),
		],
		tools: [
			defineTool({
				name: "send_message",
				description:
					"Send text and/or a local file to this chat now, or to another chat by chatGuid. Returns the send receipt; an unknown status may have been sent and must not be repeated blindly.",
				parameters: Type.Object({
					text: Type.Optional(Type.String()),
					filePath: Type.Optional(Type.String()),
					chatGuid: Type.Optional(Type.String()),
				}),
				// The task ID is the request ID: a replayed call returns the first receipt instead of sending again.
				replay: "safe",
				async execute(args, api, context) {
					const chatGuid = args.chatGuid ?? (await owner(api.conversationId, context));
					const receipt = await clock.send({
						chatGuid,
						requestId: `message:${api.taskId}`,
						text: args.text,
						filePath: args.filePath,
					});
					return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
				},
			}),
			defineTool({
				name: "schedule_task",
				description:
					"Schedule a prompt for later, optionally repeating. Uses the service clock, not this conversation's lifetime.",
				parameters: Type.Object({
					when: Type.String(),
					prompt: Type.String(),
					every: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(args, api, context) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									clock.schedule(
										await owner(api.conversationId, context),
										args.when,
										args.prompt,
										args.every,
										`schedule:${api.taskId}`,
									),
								),
							},
						],
					};
				},
			}),
			defineTool({
				name: "list_scheduled_tasks",
				description: "List this chat's scheduled prompts.",
				parameters: Type.Object({}),
				replay: "safe",
				async execute(_args, api, context) {
					return {
						content: [
							{ type: "text", text: JSON.stringify(clock.list(await owner(api.conversationId, context))) },
						],
					};
				},
			}),
			defineTool({
				name: "cancel_scheduled_task",
				description: "Cancel a pending task or loop by ID in this chat.",
				parameters: Type.Object({ id: Type.String() }),
				replay: "safe",
				async execute(args, api, context) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(clock.cancel(await owner(api.conversationId, context), args.id)),
							},
						],
					};
				},
			}),
			defineTool({
				name: "watch_background",
				description:
					"Register a fresh completion JSON before starting detached work; summaries are read-only and delivered separately.",
				parameters: Type.Object({
					completionFile: Type.String(),
					instruction: Type.String(),
					waitMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
				}),
				replay: "safe",
				async execute(args, api, context) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(clock.watch(await owner(api.conversationId, context), args)),
							},
						],
					};
				},
			}),
		],
	});
}
