import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineDoc,
	type EntryId,
	type Harness,
	type Storage,
} from "@earendil-works/pi-durable";
import type { MessageSender } from "../transport/send.ts";
import { Chats } from "./chats.ts";

export type SendText = MessageSender["sendMessage"];
export type DeliveryStatus = "sending" | "sent" | "unknown";

export const Deliveries = defineDoc<{ answers: Record<string, DeliveryStatus> }>({
	kind: "imessage.deliveries",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ answers: {} }),
});

export async function recoverSending(harness: Harness) {
	const chats = await harness.snapshot(Chats, BACKGROUND_CONTEXT);
	for (const chat of chats?.items ?? []) {
		const unknown = await harness.commit(async (tx) => {
			const deliveries = await tx.doc(Deliveries, chat.conversationId);
			const changed: string[] = [];
			for (const [answerId, status] of Object.entries(deliveries.answers)) {
				if (status === "sending") {
					deliveries.answers[answerId] = "unknown";
					changed.push(answerId);
				}
			}
			return changed;
		}, BACKGROUND_CONTEXT);
		for (const answerId of unknown) console.warn("Reply delivery unknown", chat.conversationId, answerId);
	}
}

async function deliverAnswer(
	harness: Harness,
	conversationId: ConversationId,
	answerId: EntryId,
	chatGuid: string,
	send: SendText,
) {
	const text = await harness.commit(async (tx) => {
		const entry = await tx.entry(AssistantEntry, answerId);
		if (!entry || entry.conversationId !== conversationId)
			throw new Error("Reply entry is missing or belongs to another chat");
		const message = entry.model?.[0];
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
		if (!text) return;
		const deliveries = await tx.doc(Deliveries, conversationId);
		if (deliveries.answers[String(answerId)]) return;
		deliveries.answers[String(answerId)] = "sending";
		return text;
	}, BACKGROUND_CONTEXT);
	if (!text) return;

	let status: DeliveryStatus = "sent";
	try {
		await send(chatGuid, text);
	} catch {
		// A throwing transport may already have sent. Never retry it automatically.
		status = "unknown";
	}
	await harness.commit(async (tx) => {
		(await tx.doc(Deliveries, conversationId)).answers[String(answerId)] = status;
	}, BACKGROUND_CONTEXT);
	if (status === "unknown") console.warn("Reply delivery unknown", conversationId, String(answerId));
}

export async function deliverReplies(
	harness: Harness,
	storage: Storage,
	send: SendText,
	enabled: (chatGuid: string) => boolean,
) {
	const chats = await harness.snapshot(Chats, BACKGROUND_CONTEXT);
	const destinations = new Map(chats?.items.map((chat) => [chat.conversationId, chat.chatGuid]));
	let cursor: Cursor | undefined;
	do {
		// Read settled inputs, not a transient watch: several inputs can share one answer.
		const page = await storage.scanSubmissions({ status: "done" }, 100, cursor, BACKGROUND_CONTEXT);
		for (const submission of page.items) {
			const chatGuid = destinations.get(submission.conversationId);
			if (submission.type === "input" && submission.status === "done" && chatGuid && enabled(chatGuid)) {
				await deliverAnswer(harness, submission.conversationId, submission.answer, chatGuid, send);
			}
		}
		cursor = page.next;
	} while (cursor);
}
