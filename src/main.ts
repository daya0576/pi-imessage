import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { type AgentDefaults, type MessageInput, submitMessage, WatchCursor } from "./agent/chats.ts";
import { isCommand } from "./agent/commands.ts";
import { deliverReplies, recoverSending, type SendText } from "./agent/deliver.ts";
import { openHarness } from "./agent/harness.ts";
import { openModels, readDefaults, withCodexFast } from "./agent/models.ts";
import { isReplyEnabled, readSettings } from "./config/settings.ts";
import { archiveAttachments } from "./transport/attachments.ts";
import { createWatcher } from "./transport/watch.ts";

/** Explicit startup; pass an isolated runtime in tests instead of opening installed auth. */
export async function startService(options: {
	workingDir: string;
	runtime?: { models: Models; defaults: AgentDefaults };
	extensions: readonly Extension[];
	send: SendText;
}) {
	const extensions = [...options.extensions];
	let runtime = options.runtime;
	await readSettings(options.workingDir);
	if (!runtime) {
		const models = await openModels();
		runtime = { models, defaults: await readDefaults(models, options.workingDir) };
	}
	const defaults = { ...runtime.defaults, model: { ...runtime.defaults.model } };
	if (!runtime.models.getModel(defaults.model.provider, defaults.model.modelId))
		throw new Error(`Model is unavailable: ${defaults.model.provider}/${defaults.model.modelId}`);
	const owner = await openHarness(options.workingDir, withCodexFast(runtime.models), extensions);
	const { harness, storage } = owner;
	try {
		await recoverSending(harness);
	} catch (error) {
		await owner.close();
		throw error;
	}

	let closed = false;
	let closing: Promise<void> | undefined;
	const operations = new Set<Promise<unknown>>();
	function track<T>(run: () => Promise<T>): Promise<T> {
		if (closed) return Promise.reject(new Error("Agent is closed"));
		const operation = run();
		operations.add(operation);
		void operation.finally(() => operations.delete(operation)).catch(() => {});
		return operation;
	}

	return {
		harness,
		submit(input: MessageInput, { logDisabled = false } = {}) {
			const snapshot = { ...input, attachments: input.attachments ? [...input.attachments] : undefined };
			return track(async () => {
				const settings = await readSettings(options.workingDir);
				const enabled = isReplyEnabled(settings, snapshot.chatGuid);
				if (!enabled && !logDisabled) throw new Error("Chat is disabled");
				if (enabled && isCommand(snapshot.text))
					throw new Error("Commands are not supported by this entry point yet");
				return submitMessage(harness, defaults, snapshot, enabled);
			});
		},
		// Explicit host boundary; no model loop, timer or transport runs on import.
		deliver() {
			return track(async () => {
				const settings = await readSettings(options.workingDir);
				await deliverReplies(
					harness,
					storage,
					(chatGuid, text) => options.send(chatGuid, text, settings.richText),
					(chatGuid) => isReplyEnabled(settings, chatGuid),
				);
			});
		},
		close() {
			closed = true;
			closing ??= (async () => {
				await Promise.allSettled([...operations]);
				await owner.close();
			})();
			return closing;
		},
	};
}

/** One host poll loop for incoming rows and saved replies; Durable owns model execution. */
export async function startMessaging(
	options: Parameters<typeof startService>[0] & {
		dbPath: string;
		intervalMs?: number;
		onError(error: unknown): void;
	},
) {
	const intervalMs = options.intervalMs ?? 2000;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Invalid messaging poll interval");
	const service = await startService(options);
	let watcher: ReturnType<typeof createWatcher>;
	try {
		const cursor = await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT);
		watcher = createWatcher({
			dbPath: options.dbPath,
			cursor: cursor?.rowid,
			async accept(message) {
				const attachments = await archiveAttachments(
					options.workingDir,
					message.chatGuid,
					message.attachments,
				);
				await service.submit({ ...message, attachments }, { logDisabled: true });
			},
			saveCursor: (rowid) =>
				service.harness.commit(async (tx) => {
					(await tx.doc(WatchCursor)).rowid = rowid;
				}, BACKGROUND_CONTEXT),
			onError: options.onError,
		});
		try {
			// Save even a fresh high-water mark, so downtime before the first message cannot create a gap.
			await service.harness.commit(async (tx) => {
				(await tx.doc(WatchCursor)).rowid = watcher.cursor;
			}, BACKGROUND_CONTEXT);
			// Resume saved work once; do not rebuild Durable's recovery or model loop in the host.
			service.harness.resume();
		} catch (error) {
			await watcher.stop();
			throw error;
		}
	} catch (error) {
		await service.close();
		throw error;
	}

	let closed = false;
	let pending: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout>;
	function poll() {
		if (closed) return Promise.reject(new Error("Messaging is closed"));
		pending ??= (async () => {
			try {
				await watcher.poll();
			} finally {
				// An unreadable attachment must not strand another chat's completed reply.
				if (!closed) await service.deliver();
			}
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	}
	function tick() {
		void poll()
			.catch(options.onError)
			.finally(() => {
				if (!closed) timer = setTimeout(tick, intervalMs);
			});
	}
	timer = setTimeout(tick, 0);
	return {
		harness: service.harness,
		poll,
		close() {
			closed = true;
			clearTimeout(timer);
			closing ??= (async () => {
				await watcher.stop();
				await pending?.catch(() => {});
				await service.close();
			})();
			return closing;
		},
	};
}
