/**
 * Message pipeline — lifecycle-based processing for incoming messages.
 *
 *   before (× 1) ──► start ──┬── emit reply ──► end (× 1)
 *                            ├── emit reply ──► end (× 1)
 *                            └── ...done
 *
 *   before : Filter & prepare. Runs once. Sets shouldContinue=false to drop.
 *   start  : Calls agent. Invokes emit() for each reply produced.
 *            Sets shouldContinue=false on outgoing to skip remaining start tasks.
 *   end    : Runs once per emitted reply (send, log, store).
 *            Receives ChatContext (not IncomingMessage) — only chat-level identity.
 */

import { joinTextBatch } from "./message-batch.js";
import type { ChatContext, IncomingMessage, OutgoingMessage } from "./types.js";
import { createOutgoingMessage, toChatContext } from "./types.js";

export type BeforeTask = (
	chat: ChatContext,
	incoming: IncomingMessage,
	outgoing: OutgoingMessage
) => Promise<OutgoingMessage> | OutgoingMessage;

/** emit() queues end-phase processing for one reply. Synchronous — does not block the caller. */
export type EmitFn = (outgoing: OutgoingMessage) => void;
export type StartTask = (
	chat: ChatContext,
	incoming: IncomingMessage,
	outgoing: OutgoingMessage,
	emit: EmitFn
) => Promise<void>;

export type EndTask = (chat: ChatContext, outgoing: OutgoingMessage) => Promise<OutgoingMessage> | OutgoingMessage;

export interface MessagePipeline {
	before(task: BeforeTask): void;
	start(task: StartTask): void;
	end(task: EndTask): void;
	process(incoming: IncomingMessage): Promise<OutgoingMessage>;
	processBatch(incoming: IncomingMessage[]): Promise<void>;
}

export function createMessagePipeline(): MessagePipeline {
	const beforeTasks: BeforeTask[] = [];
	const startTasks: StartTask[] = [];
	const endTasks: EndTask[] = [];

	async function runEndTasks(chat: ChatContext, outgoing: OutgoingMessage): Promise<void> {
		let result = outgoing;
		for (const task of endTasks) {
			result = await task(chat, result);
			if (!result.shouldContinue) return;
		}
	}

	async function prepare(incoming: IncomingMessage): Promise<OutgoingMessage> {
		const chat = toChatContext(incoming);
		let outgoing = createOutgoingMessage();
		for (const task of beforeTasks) {
			outgoing = await task(chat, incoming, outgoing);
			if (!outgoing.shouldContinue) break;
		}
		return outgoing;
	}

	async function run(incoming: IncomingMessage, outgoing: OutgoingMessage): Promise<OutgoingMessage> {
		const chat = toChatContext(incoming);
		// emit() is sync — queues end tasks onto endChain for serialized execution
		let endChain = Promise.resolve();
		const emit: EmitFn = (out) => {
			endChain = endChain
				.then(() => runEndTasks(chat, out))
				.catch((error) => {
					console.error(`[pipeline] end task error for ${chat.chatGuid}:`, error);
				});
		};
		for (const task of startTasks) {
			await task(chat, incoming, outgoing, emit);
			if (!outgoing.shouldContinue) break;
		}
		await endChain;

		return outgoing;
	}

	async function process(incoming: IncomingMessage): Promise<OutgoingMessage> {
		const outgoing = await prepare(incoming);
		return outgoing.shouldContinue ? run(incoming, outgoing) : outgoing;
	}

	async function processBatch(messages: IncomingMessage[]): Promise<void> {
		if (messages.length === 0) return;
		if (messages.length === 1) {
			await process(messages[0]);
			return;
		}
		// Validate before any task can mutate an input or produce a side effect.
		joinTextBatch(messages);
		const prepared: IncomingMessage[] = [];
		let firstOutgoing: OutgoingMessage | undefined;
		for (const message of messages) {
			try {
				// Log/store/filter each ORIGINAL message, never the synthetic joined text.
				const outgoing = await prepare(message);
				if (outgoing.shouldContinue) {
					prepared.push(message);
					firstOutgoing ??= outgoing;
				}
			} catch (error: unknown) {
				console.error(`[pipeline] before task error for ${message.chatGuid}:`, error);
			}
		}
		if (firstOutgoing) await run(joinTextBatch(prepared), firstOutgoing);
	}

	return {
		before: (task) => beforeTasks.push(task),
		start: (task) => startTasks.push(task),
		end: (task) => endTasks.push(task),
		process,
		processBatch,
	};
}
