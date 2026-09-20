/**
 * iMessage bot — pulls IncomingMessage objects from a queue (fed by the
 * watcher) and runs them through the pipeline (before → start → end).
 *
 *   watcher → queue → pipeline.process()
 *
 * Different chats run concurrently. Idle chats start immediately. While a
 * chat is busy, consecutive same-sender plain-text messages can be processed
 * as one turn. Commands, attachments, quotes, and sender changes split batches.
 */

import type { AgentManager } from "./agent.js";
import { type GoalController, parseGoalCommand } from "./goal.js";
import type { DigestLogger } from "./logger.js";
import { createMessageBatchQueue } from "./message-batch.js";
import { createMessagePipeline } from "./pipeline.js";
import { type AsyncQueue, QueueClosedError } from "./queue.js";
import type { SelfEchoFilter } from "./self-echo.js";
import type { MessageSender } from "./send.js";
import { isReplyEnabled } from "./settings.js";
import type { Settings } from "./settings.js";
import type { ChatStore } from "./store.js";
import {
	createArchiveImagesTask,
	createCallAgentTask,
	createCheckReplyEnabledTask,
	createCommandHandlerTask,
	createDownloadImagesTask,
	createDropSelfEchoTask,
	createLogIncomingTask,
	createLogOutgoingTask,
	createResizeImagesTask,
	createSendReplyTask,
	createStoreIncomingTask,
	createStoreOutgoingTask,
} from "./tasks.js";
import {
	type ChatContext,
	type OutgoingMessage,
	createOutgoingMessage,
	formatAgentReply,
	toChatContext,
} from "./types.js";
import type { IncomingMessage } from "./types.js";

// ── iMessage bot ──────────────────────────────────────────────────────────────

export interface IMessageBotConfig {
	queue: AsyncQueue<IncomingMessage>;
	goals?: GoalController;
	agent: AgentManager;
	sender: MessageSender;
	echoFilter: SelfEchoFilter;
	store: ChatStore;
	getSettings: () => Settings;
	digestLogger: DigestLogger;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { queue, agent, sender, echoFilter, store, getSettings, digestLogger } = config;
	const pipeline = createMessagePipeline();
	const goals = config.goals;
	let running = false;
	const chats = new Map<string, ChatContext>();
	const sendReply = createSendReplyTask(echoFilter, sender, getSettings);
	const logReply = createLogOutgoingTask(digestLogger);
	const storeReply = createStoreOutgoingTask(store);
	const enabled = (chatGuid: string) => running && isReplyEnabled(getSettings(), chatGuid);
	const waiting = new Map<string, number>();
	const hasQueuedInput = (chatGuid: string) => (waiting.get(chatGuid) ?? 0) > 0;
	const controlEpochs = new Map<string, number>();

	// ── Pipeline tasks ─────────────────────────────────────────────────────────
	//
	//   before -> start ──┬── yield reply -> end
	//                     ├── yield reply -> end
	//                     └── ...done

	// before
	pipeline.before(createLogIncomingTask(digestLogger));
	pipeline.before(createDropSelfEchoTask(echoFilter));
	pipeline.before(createArchiveImagesTask(store));
	pipeline.before(createStoreIncomingTask(store));
	pipeline.before(createCheckReplyEnabledTask(getSettings));
	pipeline.before(createDownloadImagesTask());
	pipeline.before(createResizeImagesTask());

	// start: fence delayed lifecycle replies when a newer mutating command is admitted.
	pipeline.start(async (chat, incoming, outgoing) => {
		const command = incoming.text?.trim() ?? "";
		if (/^\/(stop|new|reload)$/.test(command) || /^\/goal(?:\s|$)/.test(command)) {
			if (!/^\/goal(?:\s+status)?$/.test(command))
				controlEpochs.set(chat.chatGuid, (controlEpochs.get(chat.chatGuid) ?? 0) + 1);
			const epoch = controlEpochs.get(chat.chatGuid);
			outgoing.isCurrent = () => enabled(chat.chatGuid) && controlEpochs.get(chat.chatGuid) === epoch;
		}
	});
	pipeline.start(async (chat, incoming, outgoing, emit, admitted) => {
		if (!goals) return;
		const text = incoming.text?.trim() ?? "";
		let argument: string | undefined;
		try {
			argument = parseGoalCommand(text);
		} catch (error) {
			admitted?.();
			emit({ ...outgoing, reply: { type: "message", text: String(error) } });
			outgoing.shouldContinue = false;
			return;
		}
		if (argument === undefined) return;
		outgoing.shouldContinue = false;
		let cancellation: Promise<void> | undefined;
		try {
			// stop() fences synchronously and reserves ownership before a replacement is saved.
			// Never create/restore a goal after await: a later pause/clear must win.
			if (!["status", "resume"].includes(argument)) {
				cancellation = agent.stop(chat.chatGuid);
				void cancellation.catch(() => {}); // Observed below, including a failed checkpoint write.
			}
			const text = goals.command(chat.chatGuid, argument);
			chats.set(chat.chatGuid, toChatContext(incoming));
			admitted?.();
			await cancellation;
			emit({
				...outgoing,
				shouldContinue: true,
				isCurrent: outgoing.isCurrent,
				reply: { type: "message", text },
			});
		} catch (error) {
			admitted?.();
			if (cancellation && outgoing.isCurrent?.()) {
				try {
					goals.pause(chat.chatGuid, "取消或目标变更未确认，已暂停；核对实际结果后再显式恢复。");
				} catch (checkpointError) {
					console.error(`[goal] failed-closed command checkpoint unavailable: ${chat.chatGuid}`, checkpointError);
				}
			}
			console.error(`[goal] command failed closed; later controls remain admissible: ${chat.chatGuid}`, error);
			emit({
				...outgoing,
				shouldContinue: true,
				reply: { type: "message", text: `目标操作未确认，未恢复自动执行：${String(error)}` },
			});
		}
	});
	pipeline.start(createCommandHandlerTask(agent, hasQueuedInput));
	pipeline.start(createCallAgentTask(agent, hasQueuedInput));

	// end
	pipeline.end(sendReply);
	pipeline.end(logReply);
	pipeline.end(storeReply);

	return {
		start() {
			running = true;
			const batches = createMessageBatchQueue(
				async (messages) => {
					const chatGuid = messages[0].chatGuid;
					const remaining = (waiting.get(chatGuid) ?? messages.length) - messages.length;
					if (remaining > 0) waiting.set(chatGuid, remaining);
					else waiting.delete(chatGuid);
					if (messages.length > 1) {
						console.log(`[batch] ${messages[0].chatGuid}: merged ${messages.length} pending text messages`);
					}
					try {
						await pipeline.processBatch(messages);
					} finally {
						// Ack whether processing succeeded or failed-closed: the batch queue does not
						// retry in-process, so leaving it unacked would replay forever across restarts.
						for (const message of messages) queue.ack(message);
					}
				},
				async (chatGuid) => {
					const chat = chats.get(chatGuid);
					if (!goals || !chat) return false;
					try {
						return await goals.runOne(
							chat,
							agent,
							() => enabled(chatGuid),
							() => hasQueuedInput(chatGuid),
							async (reply) => {
								let outgoing: OutgoingMessage = {
									...createOutgoingMessage(),
									isCurrent: reply.isCurrent,
									reply: { type: "message" as const, text: formatAgentReply(reply) },
								};
								for (const task of [sendReply, logReply, storeReply]) {
									if (!enabled(chatGuid) || (outgoing.isCurrent && !outgoing.isCurrent())) return;
									outgoing = await task(chat, outgoing);
									if (!outgoing.shouldContinue) return;
								}
							}
						);
					} catch (error) {
						console.error(`[goal] idle execution failed closed: ${chatGuid}`, error);
						return false;
					}
				}
			);

			async function loop(): Promise<void> {
				while (true) {
					const msg = await queue.pull();

					// Preserve the current cancellation/admission pipeline and split batches.
					const command = msg.text?.trim();
					if (
						command === "/stop" ||
						command === "/new" ||
						command === "/reload" ||
						/^\/goal(?:\s|$)/.test(command ?? "")
					) {
						batches.boundary(msg.chatGuid);
						let admit = () => {};
						const admission = new Promise<void>((resolve) => {
							admit = resolve;
						});
						// Keep preflight/fencing in input order, not SDK cancellation or send settlement.
						void pipeline.process(msg, admit).then(
							() => {
								queue.ack(msg);
								batches.wake(msg.chatGuid);
							},
							(error: unknown) => {
								// Control command settled (failed closed); do not replay it on restart.
								queue.ack(msg);
								console.error("[sid] control command settlement failed", error);
							}
						);
						await admission;
						console.log(
							`[sid] control admission finished: ${msg.chatGuid}; cancellation/delivery does not block queue`
						);
						continue;
					}

					waiting.set(msg.chatGuid, (waiting.get(msg.chatGuid) ?? 0) + 1);
					batches.enqueue(msg);
				}
			}

			loop().catch((error: unknown) => {
				if (error instanceof QueueClosedError) {
					console.log("[sid] Queue closed, consumer stopped");
				} else {
					console.error("[sid] Consumer crashed:", error);
				}
			});
		},
		stop() {
			running = false;
			queue.close();
		},
	};
}
