import type { Message } from "@earendil-works/pi-ai";
import { defineDoc, type EntryId } from "@earendil-works/pi-durable";

export type DeliveryStatus = "sending" | "sent" | "unknown";
export type DraftDisposition =
	| { status: "held"; reason: "newer_input" }
	| { status: "superseded"; replacement: EntryId }
	| { status: "cancelled" };

export const Deliveries = defineDoc<{
	answers: Record<string, DeliveryStatus>;
	drafts?: Record<string, DraftDisposition>;
	/** Every final answer up to this entry has a receipt or a draft disposition. */
	scanned?: EntryId;
}>({
	kind: "imessage.deliveries",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ answers: {} }),
});

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
