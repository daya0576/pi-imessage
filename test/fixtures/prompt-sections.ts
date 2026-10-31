import type { Message } from "@earendil-works/pi-ai";

const UPDATE = /^<prompt_update>\n/;
const SECTION =
	/(Updated|Removed) system prompt section "([^"]+)"(?::\n\n([\s\S]*?))?(?=\n\n(?:Updated|Removed) system prompt section "|\n<\/prompt_update>$)/g;

/** Current prompt sections a model sees, whether changes arrive as system entries or prompt updates (ADR 0057). */
export function currentSections(messages: Message[]) {
	const sections: Record<string, string> = {};
	for (const message of messages) {
		if (message.role === "system")
			for (const [name, value] of Object.entries(message.sections ?? {}))
				if (value === null) delete sections[name];
				else sections[name] = value;
		if (message.role === "user" && typeof message.content === "string" && UPDATE.test(message.content))
			for (const [, kind, name, value] of message.content.matchAll(SECTION))
				if (kind === "Removed") delete sections[name];
				else sections[name] = value ?? "";
	}
	return sections;
}

/** The latest message written by the user, skipping host prompt updates. */
export function lastUserMessage(messages: Message[]) {
	return messages.findLast(
		(message) =>
			message.role === "user" && !(typeof message.content === "string" && UPDATE.test(message.content)),
	);
}
