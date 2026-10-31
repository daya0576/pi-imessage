import type { Message } from "@earendil-works/pi-ai";

/** Text written next to tool calls in one assistant message: the model's interim update. */
export function interimText(message: Message | undefined) {
	if (message?.role !== "assistant" || message.stopReason !== "toolUse") return;
	if (!message.content.some((part) => part.type === "toolCall")) return;
	const text = message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
	return text || undefined;
}

/** The same final-only projection is used for transport and the model's delivery facts. */
export function finalReplyText(message: Message | undefined) {
	if (message?.role !== "assistant" || !["stop", "length"].includes(message.stopReason)) return;
	if (message.content.some((part) => part.type === "toolCall")) return;
	const text = message.content
		.filter((part) => {
			if (part.type !== "text") return false;
			try {
				const signature = JSON.parse(part.textSignature ?? "null");
				return !(signature?.v === 1 && signature.phase === "commentary");
			} catch {
				return true; // Opaque provider signatures are not channel labels.
			}
		})
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
	return text || undefined;
}
