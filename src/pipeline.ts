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

	async function process(incoming: IncomingMessage): Promise<OutgoingMessage> {
		const chat = toChatContext(incoming);
		let outgoing = createOutgoingMessage();

		for (const task of beforeTasks) {
			outgoing = await task(chat, incoming, outgoing);
			if (!outgoing.shouldContinue) return outgoing;
		}

		// emit() is sync — queues end tasks onto endChain for serialized execution
		let endChain = Promise.resolve();
		const emit: EmitFn = (out) => {
			endChain = endChain.then(() => runEndTasks(chat, out));
		};
		for (const task of startTasks) {
			await task(chat, incoming, outgoing, emit);
			if (!outgoing.shouldContinue) break;
		}
		await endChain;

		return outgoing;
	}

	return {
		before: (task) => beforeTasks.push(task),
		start: (task) => startTasks.push(task),
		end: (task) => endTasks.push(task),
		process,
	};
}
