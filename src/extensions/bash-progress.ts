import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";

const bash = createBashTool();

/** Keep native execution; the optional label is only for chat progress. */
export const BashProgress = defineExtension({
	name: "bash-progress",
	tools: [
		defineTool({
			...bash,
			description: `${bash.description} Include a short description of the purpose in the user's language for progress notices. Use everyday words for the action, not implementation jargon; for example, say 让新格式生效 rather than 重启加载保留类型前缀的新格式. Never include commands, secrets or URLs in the description.`,
			parameters: Type.Object({
				...bash.parameters.properties,
				description: Type.Optional(
					Type.String({
						description: "Short, non-sensitive purpose in the user's language (not the command)",
						maxLength: 80,
					}),
				),
			}),
			async execute(args, api, context) {
				return bash.execute({ command: args.command, timeout: args.timeout }, api, context);
			},
		}),
	],
});
