import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	type EntryId,
	type Harness,
	type Storage,
} from "@earendil-works/pi-durable";
import { finalReplyText } from "../extensions/final-text.ts";
import type { MessageSender } from "../transport/send.ts";
import { Chats } from "./chats.ts";
import { DirectSends } from "./direct-send.ts";
import { Sessions } from "./isolated.ts";
import { Deliveries, type DeliveryStatus } from "./replies.ts";
import { RUN_RECORD, Runs, runRecord } from "./run.ts";

export type SendText = MessageSender["sendMessage"];

/**
 * A conversation whose final answers go to a chat. Runs and tasks also record sent replies in the chat
 * conversation, so the chat's context holds what the user saw, not how it was produced.
 */
type Target = { conversationId: ConversationId; chatGuid: string; chat?: ConversationId; label?: string };

async function targets(harness: Harness): Promise<Target[]> {
	const chats = (await harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items ?? [];
	const runs = (await harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items ?? [];
	const sessions = (await harness.snapshot(Sessions, BACKGROUND_CONTEXT))?.items ?? [];
	return [
		...chats,
		...sessions
			.filter((session) => session.deliver)
			.map((session) => ({ ...session, label: `task ${session.label}` })),
		...runs.map((run) => ({
			conversationId: run.conversationId,
			chatGuid: run.chatGuid,
			chat: run.chat,
			label: "/run reply",
		})),
	];
}

export async function recoverSending(harness: Harness) {
	const directUnknown = await harness.commit(async (tx) => {
		const sends = await tx.doc(DirectSends);
		const changed: { chatGuid: string; requestId: string; part: string }[] = [];
		for (const receipt of sends.requests) {
			for (const part of ["textStatus", "fileStatus"] as const) {
				if (receipt[part] !== "sending") continue;
				receipt[part] = "unknown";
				changed.push({ chatGuid: receipt.chatGuid, requestId: receipt.requestId, part });
			}
		}
		return changed;
	}, BACKGROUND_CONTEXT);
	for (const { chatGuid, requestId, part } of directUnknown)
		console.warn("Direct delivery unknown", chatGuid, requestId, part);
	for (const { conversationId } of await targets(harness)) {
		const unknown = await harness.commit(async (tx) => {
			const deliveries = await tx.doc(Deliveries, conversationId);
			const changed: string[] = [];
			for (const [answerId, status] of Object.entries(deliveries.answers)) {
				if (status === "sending") {
					deliveries.answers[answerId] = "unknown";
					changed.push(answerId);
				}
			}
			return changed;
		}, BACKGROUND_CONTEXT);
		for (const answerId of unknown) console.warn("Reply delivery unknown", conversationId, answerId);
	}
}

/** Returns false when the answer must wait for an earlier in-flight send. */
async function deliverAnswer(
	harness: Harness,
	storage: Storage,
	target: Target,
	answerId: EntryId,
	send: SendText,
) {
	const { conversationId } = target;
	const claim = await harness.commit(async (tx) => {
		const entry = await tx.entry(AssistantEntry, answerId);
		const text = finalReplyText(entry?.model?.[0]);
		const deliveries = await tx.doc(Deliveries, conversationId);
		const key = String(answerId);
		const decided = () => {
			if (deliveries.scanned === undefined || deliveries.scanned < answerId) deliveries.scanned = answerId;
			return true;
		};
		if (!text || deliveries.answers[key] || deliveries.drafts?.[key]) return { decided: decided() };

		// The owning Session serializes admission with this claim. Read committed native submissions,
		// not arbitrary user entries: passive logs and /run continuation text are not new human input.
		let intervening = false;
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanSubmissions({ conversationId }, 100, cursor, BACKGROUND_CONTEXT);
			intervening = page.items.some(
				(input) =>
					input.type === "input" &&
					(input.status === "queued" || (input.entry !== undefined && input.entry > answerId)),
			);
			cursor = page.next;
		} while (cursor && !intervening);
		if (intervening) {
			deliveries.drafts ??= {};
			deliveries.drafts[key] = { status: "held", reason: "newer_input" };
			return { decided: decided() };
		}
		// Do not overtake an earlier in-flight send in this chat.
		if (Object.values(deliveries.answers).includes("sending")) return { decided: false };

		// Finals are claimed in order, so the only earlier unsent ones are held drafts; this answer replaces them.
		const drafts = deliveries.drafts ?? {};
		for (const [previous, draft] of Object.entries(drafts))
			if (draft.status === "held" && Number(previous) < answerId)
				drafts[previous] = { status: "superseded", replacement: answerId };
		deliveries.answers[key] = "sending";
		return { decided: decided(), text };
	}, BACKGROUND_CONTEXT);
	if (!claim.text) return claim.decided;

	let status: DeliveryStatus = "sent";
	try {
		await send(target.chatGuid, claim.text);
	} catch {
		// A throwing transport may already have sent. Never retry it automatically.
		status = "unknown";
	}
	await harness.commit(async (tx) => {
		(await tx.doc(Deliveries, conversationId)).answers[String(answerId)] = status;
	}, BACKGROUND_CONTEXT);
	if (status === "unknown") console.warn("Reply delivery unknown", conversationId, String(answerId));
	if (target.chat !== undefined) {
		// A queued write never splits a turn that is running in the chat conversation.
		const chat = await harness.conversation(target.chat, BACKGROUND_CONTEXT);
		await chat?.submit(
			{
				type: "write",
				requestId: `${RUN_RECORD}:${answerId}`,
				entry: runRecord(`[${target.label}, ${status}]\n${claim.text}`, Date.now()),
			},
			BACKGROUND_CONTEXT,
		);
	}
	return true;
}

/** Sends committed final answers in order, including those a /run writes between continuations. */
export async function deliverReplies(
	harness: Harness,
	storage: Storage,
	send: SendText,
	enabled: (chatGuid: string) => boolean,
) {
	for (const target of await targets(harness)) {
		if (!enabled(target.chatGuid)) continue;
		const scanned = (await harness.snapshot(Deliveries, target.conversationId, BACKGROUND_CONTEXT))?.scanned;
		const answers: EntryId[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanEntries(
				{ conversationId: target.conversationId, ...(scanned === undefined ? {} : { minEntryId: scanned }) },
				100,
				cursor,
				BACKGROUND_CONTEXT,
			);
			for (const entry of page.items)
				if (AssistantEntry.is(entry) && finalReplyText(entry.model?.[0])) answers.push(entry.id);
			cursor = page.next;
		} while (cursor);
		for (const answerId of answers.reverse())
			if (!(await deliverAnswer(harness, storage, target, answerId, send))) break;
	}
}
