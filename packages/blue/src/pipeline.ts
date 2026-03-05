/**
 * Message pipeline — lifecycle-based processing for incoming messages.
 *
 * Three phases run in order for each message:
 *
 *   before  →  start  →  end
 *
 *   before : Pre-processing & filtering (echo detection, logging, etc.).
 *            Any task setting `shouldContinue = false` drops the message —
 *            remaining before-tasks and all later phases are skipped.
 *   start  : Core handling — calls the bot/agent to produce a reply.
 *   end    : Post-processing — send reply, log outgoing, remember echo, etc.
 *
 * Both IncomingMessage and OutgoingMessage flow through every phase as context.
 * Tasks within each phase run sequentially in registration order.
 */

import type { IncomingMessage, OutgoingMessage } from "./types.js";
import { createOutgoingMessage } from "./types.js";

// ── Task types ────────────────────────────────────────────────────────────────

/** A before-task may filter (set shouldContinue=false) or mutate the outgoing context. */
export type BeforeTask = (incoming: IncomingMessage, outgoing: OutgoingMessage) => OutgoingMessage;

/** The start-task receives both messages and produces an updated outgoing context. */
export type StartTask = (incoming: IncomingMessage, outgoing: OutgoingMessage) => Promise<OutgoingMessage>;

/** An end-task receives both messages and may produce an updated outgoing context. */
export type EndTask = (
	incoming: IncomingMessage,
	outgoing: OutgoingMessage
) => Promise<OutgoingMessage> | OutgoingMessage;

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface MessagePipeline {
	before(task: BeforeTask): void;
	start(task: StartTask): void;
	end(task: EndTask): void;
	/** Run all phases. Returns the final OutgoingMessage. */
	process(incoming: IncomingMessage): Promise<OutgoingMessage>;
}

export function createMessagePipeline(): MessagePipeline {
	const beforeTasks: BeforeTask[] = [];
	const startTasks: StartTask[] = [];
	const endTasks: EndTask[] = [];

	async function process(incoming: IncomingMessage): Promise<OutgoingMessage> {
		let outgoing = createOutgoingMessage();

		// ── before: filter & pre-process ───────────────────────────────────────
		for (const task of beforeTasks) {
			outgoing = task(incoming, outgoing);
			if (!outgoing.shouldContinue) return outgoing;
		}

		// ── start: produce reply (last registered start-task wins) ─────────────
		for (const task of startTasks) {
			outgoing = await task(incoming, outgoing);
			if (!outgoing.shouldContinue) return outgoing;
		}

		// ── end: post-process ──────────────────────────────────────────────────
		for (const task of endTasks) {
			outgoing = await task(incoming, outgoing);
			if (!outgoing.shouldContinue) return outgoing;
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
