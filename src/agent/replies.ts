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
