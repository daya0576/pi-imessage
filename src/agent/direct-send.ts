import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { MessageSender } from "../transport/send.ts";
import type { DeliveryStatus } from "./replies.ts";

export type DirectSendInput = { chatGuid: string; requestId: string; text?: string; filePath?: string };
export type DirectSendReceipt = {
	chatGuid: string;
	requestId: string;
	text: string | null;
	filePath: string | null;
	textStatus: DeliveryStatus | "not_attempted" | null;
	fileStatus: DeliveryStatus | "not_attempted" | null;
};

/** Receipts only: no background worker or automatic retry of explicit sends. */
export const DirectSends = defineDoc<{ requests: DirectSendReceipt[] }>({
	kind: "imessage.direct-sends",
	version: 1,
	scope: "session",
	initial: () => ({ requests: [] }),
});

export async function deliverDirect(harness: Harness, input: DirectSendInput, sender: MessageSender) {
	const { chatGuid, requestId } = input;
	const text = input.text || null;
	const filePath = input.filePath || null;
	if (!chatGuid.trim() || !requestId.trim() || (!text && !filePath))
		throw new Error("Chat GUID, request ID and text or file path are required");
	const accepted = await harness.commit(async (tx) => {
		const sends = await tx.doc(DirectSends);
		const existing = sends.requests.find(
			(send) => send.chatGuid === chatGuid && send.requestId === requestId,
		);
		if (existing) {
			if (existing.text !== text || existing.filePath !== filePath)
				throw new Error("Send request ID was already used with different content");
			return { claimed: false, receipt: { ...existing } };
		}
		const receipt: DirectSendReceipt = {
			chatGuid,
			requestId,
			text,
			filePath,
			textStatus: text ? "not_attempted" : null,
			fileStatus: filePath ? "not_attempted" : null,
		};
		sends.requests.push(receipt);
		return { claimed: true, receipt: { ...receipt } };
	}, BACKGROUND_CONTEXT);
	if (!accepted.claimed) return accepted.receipt;
	let receipt = accepted.receipt;

	async function setStatus(part: "textStatus" | "fileStatus", status: DeliveryStatus) {
		receipt = await harness.commit(async (tx) => {
			const sends = await tx.doc(DirectSends);
			const record = sends.requests.find(
				(send) => send.chatGuid === chatGuid && send.requestId === requestId,
			);
			if (!record) throw new Error("Direct send receipt is missing");
			record[part] = status;
			return { ...record };
		}, BACKGROUND_CONTEXT);
	}
	async function attempt(part: "textStatus" | "fileStatus", send: () => Promise<void>) {
		await setStatus(part, "sending");
		let status: DeliveryStatus = "sent";
		try {
			await send();
		} catch {
			status = "unknown";
		}
		await setStatus(part, status);
		if (status === "unknown") console.warn("Direct delivery unknown", chatGuid, requestId, part);
		return status;
	}
	// Explicit sends preserve the old /send plain-text behavior, independent of automatic reply settings.
	if (text && (await attempt("textStatus", () => sender.sendMessage(chatGuid, text))) !== "sent")
		return receipt;
	if (filePath) await attempt("fileStatus", () => sender.sendAttachment(chatGuid, filePath));
	return receipt;
}
