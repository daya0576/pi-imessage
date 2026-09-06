import type { IncomingMessage } from "./types.js";

// Bounds apply to merging, not to an individual message. Never truncate input.
export const MAX_BATCH_MESSAGES = 8;
export const MAX_BATCH_TEXT_LENGTH = 8_000;

export function isBatchableText(message: IncomingMessage): boolean {
	return Boolean(
		message.sender.trim() &&
			message.text?.trim() &&
			!message.text.trim().startsWith("/") &&
			message.replyToText === null &&
			message.attachments.length === 0 &&
			message.images.length === 0
	);
}

export function canAppendToBatch(batch: readonly IncomingMessage[], next: IncomingMessage): boolean {
	const first = batch[0];
	return Boolean(
		first &&
			batch.length < MAX_BATCH_MESSAGES &&
			batch.every(isBatchableText) &&
			isBatchableText(next) &&
			first.chatGuid === next.chatGuid &&
			first.sender === next.sender &&
			first.messageType === next.messageType &&
			first.groupName === next.groupName &&
			batch.reduce((size, message) => size + (message.text?.length ?? 0) + 2, 0) + (next.text?.length ?? 0) <=
				MAX_BATCH_TEXT_LENGTH
	);
}

export function joinTextBatch(batch: readonly IncomingMessage[]): IncomingMessage {
	const first = batch[0];
	if (!first) throw new Error("Cannot join an empty message batch");
	for (let i = 1; i < batch.length; i++) {
		if (!canAppendToBatch(batch.slice(0, i), batch[i])) {
			throw new Error("Invalid message batch boundary");
		}
	}
	if (batch.length === 1) return first;
	return { ...first, text: batch.map((message) => message.text).join("\n\n") };
}

/** No debounce: start idle chats immediately, coalesce only pending messages. */
export function createMessageBatchQueue(process: (batch: IncomingMessage[]) => Promise<void>) {
	type Entry = { message: IncomingMessage; boundary: number };
	type State = { pending: Entry[]; boundary: number };
	const chats = new Map<string, State>();

	async function drain(chatGuid: string, state: State): Promise<void> {
		while (state.pending.length > 0) {
			const first = state.pending.shift();
			if (!first) break;
			const batch = [first.message];
			while (state.pending.length > 0) {
				const next = state.pending[0];
				if (next.boundary !== first.boundary || !canAppendToBatch(batch, next.message)) break;
				batch.push(next.message);
				state.pending.shift();
			}
			try {
				await process(batch);
			} catch (error: unknown) {
				console.error(`[batch] failed to process ${batch.length} message(s) for ${chatGuid}:`, error);
			}
		}
		chats.delete(chatGuid);
	}

	return {
		enqueue(message: IncomingMessage): void {
			const existing = chats.get(message.chatGuid);
			if (existing) {
				existing.pending.push({ message, boundary: existing.boundary });
				return;
			}
			const state: State = { pending: [{ message, boundary: 0 }], boundary: 0 };
			chats.set(message.chatGuid, state);
			void drain(message.chatGuid, state);
		},
		/** Preserve the ordering boundary of a command that bypasses the queue. */
		boundary(chatGuid: string): void {
			const state = chats.get(chatGuid);
			if (state) state.boundary++;
		},
	};
}
