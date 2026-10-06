import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export function messageExtension(messaging: {
	owner(id: ConversationId): Promise<string>;
	send(input: { chatGuid: string; requestId: string; text?: string; filePath?: string }): Promise<unknown>;
}) {
	return defineExtension({
		name: "messaging",
		sections: [
			section(
				"messaging",
				() =>
					"Use send_message for files or extra messages; your final answer is sent automatically. Apply workspace extension changes with reload_extensions.",
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
				replay: "safe",
				async execute(args, api, context) {
					const chatGuid = args.chatGuid ?? (await messaging.owner(api.conversationId));
					context.abortSignal?.throwIfAborted();
					const receipt = await messaging.send({
						chatGuid,
						requestId: `message:${api.taskId}`,
						text: args.text,
						filePath: args.filePath,
					});
					return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
				},
			}),
		],
	});
}
