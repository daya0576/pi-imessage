/**
 * Message pipeline — lifecycle-based processing for incoming messages.
 *
 *   before (× 1) ──► start ──┬── dispatch reply ──► end (× 1)
 *                            ├── dispatch reply ──► end (× 1)
 *                            └── ...done
 *
 *   before : Filter & prepare. Runs once. Sets shouldContinue=false to drop.
 *   start  : Calls agent. Invokes dispatch() for each reply produced.
 *   end    : Runs once per dispatched reply (send, log, store).
 */

import type { IncomingMessage, OutgoingMessage } from "./types.js";
import { createOutgoingMessage } from "./types.js";

export type BeforeTask = (incoming: IncomingMessage, outgoing: OutgoingMessage) => Promise<OutgoingMessage> | OutgoingMessage;

/** dispatch() runs the full end phase for one reply. */
export type DispatchFn = (outgoing: OutgoingMessage) => Promise<void>;
export type StartTask = (incoming: IncomingMessage, outgoing: OutgoingMessage, dispatch: DispatchFn) => Promise<void>;

export type EndTask = (incoming: IncomingMessage, outgoing: OutgoingMessage) => Promise<OutgoingMessage> | OutgoingMessage;

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

	async function runEndTasks(incoming: IncomingMessage, outgoing: OutgoingMessage): Promise<void> {
		let result = outgoing;
		for (const task of endTasks) {
			result = await task(incoming, result);
			if (!result.shouldContinue) return;
		}
	}

	async function process(incoming: IncomingMessage): Promise<OutgoingMessage> {
		let outgoing = createOutgoingMessage();

		for (const task of beforeTasks) {
			outgoing = await task(incoming, outgoing);
			if (!outgoing.shouldContinue) return outgoing;
		}

		const dispatch: DispatchFn = (out) => runEndTasks(incoming, out);
		for (const task of startTasks) {
			await task(incoming, outgoing, dispatch);
		}

		return outgoing;
	}

	return {
		before: (task) => beforeTasks.push(task),
		start: (task) => startTasks.push(task),
		end: (task) => endTasks.push(task),
		process,
	};
}
