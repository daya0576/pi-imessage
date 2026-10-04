import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension, Submission } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	type AgentDefaults,
	chatConversation,
	type MessageInput,
	submitMessage,
	WatchCursor,
} from "./agent/chats.ts";
import { isCommand, runCommand } from "./agent/commands.ts";
import { compactChats } from "./agent/compaction.ts";
import { deliverReplies, recoverSending, type SendText } from "./agent/deliver.ts";
import { type DirectSendInput, deliverDirect } from "./agent/direct-send.ts";
import { openHarness } from "./agent/harness.ts";
import { type PromptInput, submitIsolated } from "./agent/isolated.ts";
import { openModels, readDefaults, withCodexFast } from "./agent/models.ts";
import { loadPrompt } from "./agent/prompt.ts";
import { createAutomationService } from "./automation/service.ts";
import { isReplyEnabled, readSettings } from "./config/settings.ts";
import { finalReplyText } from "./extensions/final-text.ts";
import { memoryExtension } from "./extensions/memory.ts";
import { ImageRead } from "./extensions/read-image.ts";
import { Subagent } from "./extensions/subagent.ts";
import { webExtension } from "./extensions/web.ts";
import { createServices } from "./scheduler/services.ts";
import { archiveAttachments } from "./transport/attachments.ts";
import type { MessageSender } from "./transport/send.ts";
import { createWatcher } from "./transport/watch.ts";
import { startWeb } from "./web/server.ts";

/** Explicit startup; pass an isolated runtime in tests instead of opening installed auth. */
export async function startService(options: {
	workingDir: string;
	agentDir: string;
	runtime?: { models: Models; defaults: AgentDefaults };
	/** Optional tool selection for isolated callers; rebuilt at startup and on /reload. */
	extensions?: () => readonly Extension[] | Promise<readonly Extension[]>;
	send: SendText;
	sendAttachment: MessageSender["sendAttachment"];
}) {
	let runtime = options.runtime;
	await readSettings(options.workingDir);
	// Installed auth and models; an isolated test runtime has nothing to reload.
	let installed: Awaited<ReturnType<typeof openModels>> | undefined;
	if (!runtime) {
		installed = await openModels();
		runtime = { models: installed, defaults: await readDefaults(installed, options.workingDir) };
	}
	const defaults = { ...runtime.defaults, model: { ...runtime.defaults.model } };
	if (!runtime.models.getModel(defaults.model.provider, defaults.model.modelId))
		throw new Error(`Model is unavailable: ${defaults.model.provider}/${defaults.model.modelId}`);
	async function loadExtensions() {
		return [
			await loadPrompt(options.workingDir, options.agentDir),
			// ImageRead replaces CodingTools.read, while text reads still use the native tool.
			...(options.extensions
				? await options.extensions()
				: [CodingTools, ImageRead, await memoryExtension(options.workingDir), webExtension(), Subagent]),
		];
	}
	const owner = await openHarness(options.workingDir, withCodexFast(runtime.models), await loadExtensions());
	const { harness, storage } = owner;
	try {
		await recoverSending(harness);
	} catch (error) {
		await owner.close();
		throw error;
	}

	/** Running calls keep the code they started with; later requests and new chats use the reloaded state. */
	async function reload() {
		if (installed) Object.assign(defaults, await readDefaults(installed, options.workingDir));
		for (const extension of await loadExtensions()) owner.registry.install(extension);
		return { ...defaults, model: { ...defaults.model } };
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

	const service = {
		harness,
		install(extension: Extension) {
			owner.registry.install(extension);
		},
		prompt(input: PromptInput): Promise<Submission> {
			if (!input.sessionKey)
				return service.submit({ chatGuid: input.chatGuid, guid: input.requestId, text: input.prompt });
			return track(async () => {
				if (
					input.deliver !== false &&
					!isReplyEnabled(await readSettings(options.workingDir), input.chatGuid)
				)
					throw new Error("Chat is disabled");
				return submitIsolated(harness, defaults, input);
			});
		},
		async health() {
			const started = Date.now();
			const submission = await service.prompt({
				chatGuid: "health",
				prompt: "Reply OK.",
				requestId: crypto.randomUUID(),
				sessionKey: "model-health",
				scope: "health",
				deliver: false,
			});
			const result = await submission.wait(BACKGROUND_CONTEXT);
			if (result.status !== "done" || result.type !== "input") throw new Error("Model health request failed");
			const answer = (await harness.commit((tx) => tx.entry(result.answer), BACKGROUND_CONTEXT))?.model?.[0];
			if (answer?.role !== "assistant") throw new Error("Model health answer missing");
			return {
				ok: true,
				model: `${answer.provider}/${answer.model}`,
				latencyMs: Date.now() - started,
				checkedAt: new Date().toISOString(),
			};
		},
		async result(submission: Submission) {
			const result = await submission.wait(BACKGROUND_CONTEXT);
			if (result.status !== "done" || result.type !== "input")
				throw new Error(`Prompt ended: ${result.reason ?? result.status}`);
			const entry = await harness.commit((tx) => tx.entry(result.answer), BACKGROUND_CONTEXT);
			return finalReplyText(entry?.model?.[0]) ?? "";
		},
		submit(input: MessageInput, { logDisabled = false } = {}) {
			const snapshot = { ...input, attachments: input.attachments ? [...input.attachments] : undefined };
			return track(async () => {
				const settings = await readSettings(options.workingDir);
				const enabled = isReplyEnabled(settings, snapshot.chatGuid);
				if (!enabled && !logDisabled) throw new Error("Chat is disabled");
				if (enabled && isCommand(snapshot.text)) throw new Error("Slash commands go through command()");
				return submitMessage(harness, defaults, snapshot, enabled);
			});
		},
		/** Records the command once by its source GUID, then runs it; an interrupted command is not replayed. */
		command(input: MessageInput) {
			const snapshot = { ...input, attachments: input.attachments ? [...input.attachments] : undefined };
			return track(async () => {
				if (!isCommand(snapshot.text)) throw new Error("A slash command is required");
				const settings = await readSettings(options.workingDir);
				if (!isReplyEnabled(settings, snapshot.chatGuid)) {
					await submitMessage(harness, defaults, snapshot, false);
					return;
				}
				const conversation = await chatConversation(harness, defaults, snapshot.chatGuid);
				if (
					await harness.commit(
						(tx) => tx.submissionByRequest(conversation.id, snapshot.guid),
						BACKGROUND_CONTEXT,
					)
				)
					return;
				await conversation.submit(
					{
						type: "write",
						requestId: snapshot.guid,
						entry: { kind: "imessage.command", data: { text: snapshot.text } },
					},
					BACKGROUND_CONTEXT,
				);
				const result = await runCommand({
					harness,
					models: runtime.models,
					defaults,
					reload,
					chatGuid: snapshot.chatGuid,
					guid: snapshot.guid,
					text: snapshot.text,
				});
				const reply = async () => {
					if (result.wait !== undefined) await harness.waitForTask(result.wait, BACKGROUND_CONTEXT);
					if (result.reply)
						await deliverDirect(
							harness,
							{ chatGuid: snapshot.chatGuid, requestId: `command:${snapshot.guid}`, text: result.reply },
							{ sendMessage: options.send, sendAttachment: options.sendAttachment },
						);
				};
				// A long command (compaction) must not hold the watcher; its reply follows the task.
				if (result.wait === undefined) await reply();
				else void track(reply).catch((error) => console.warn("Command reply failed", snapshot.guid, error));
				return result;
			});
		},
		// Explicit operator/API sends bypass reply allowlists, as the old /send endpoint does.
		sendDirect(input: DirectSendInput) {
			const snapshot = { ...input };
			return track(() =>
				deliverDirect(harness, snapshot, {
					sendMessage: options.send,
					sendAttachment: options.sendAttachment,
				}),
			);
		},
		/** Admit quiet native compactions; observing their results must not hold shutdown open. */
		compact() {
			return track(async () => {
				const tasks = await compactChats(harness);
				for (const task of tasks)
					void harness
						.waitForTask(task, BACKGROUND_CONTEXT)
						.then((settled) => {
							if (settled.state.outcome.status !== "completed")
								console.warn("Scheduled compaction ended", task, settled.state.outcome);
						})
						.catch((error) => {
							if (!closed) console.warn("Scheduled compaction observation failed", task, error);
						});
				return tasks;
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
	return service;
}

/** One host poll loop for incoming rows and saved replies; Durable owns model execution. */
export async function startMessaging(
	options: Parameters<typeof startService>[0] & {
		dbPath: string;
		intervalMs?: number;
		/** Defer polling/resume until application-owned extensions and services are installed. */
		autostart?: boolean;
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
				if (isCommand(message.text)) await service.command({ ...message, attachments });
				else await service.submit({ ...message, attachments }, { logDisabled: true });
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
	let timer: ReturnType<typeof setTimeout> | undefined;
	let compactionTimer: ReturnType<typeof setInterval> | undefined;
	let started = false;
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
	function start() {
		if (closed) throw new Error("Messaging is closed");
		if (started) return;
		// Resume once, after product service extensions are installed; Durable owns recovery.
		service.harness.resume();
		started = true;
		timer = setTimeout(tick, 0);
		compactionTimer = setInterval(
			() => {
				void service.compact().catch(options.onError);
			},
			6 * 60 * 60 * 1000,
		);
		compactionTimer.unref();
	}
	try {
		if (options.autostart !== false) start();
	} catch (error) {
		await watcher.stop();
		await service.close();
		throw error;
	}
	return {
		start,
		harness: service.harness,
		install: service.install,
		prompt: service.prompt,
		result: service.result,
		health: service.health,
		sendDirect(input: DirectSendInput) {
			if (closed) return Promise.reject(new Error("Messaging is closed"));
			return service.sendDirect(input);
		},
		poll,
		close() {
			closed = true;
			clearTimeout(timer);
			clearInterval(compactionTimer);
			closing ??= (async () => {
				await watcher.stop();
				await pending?.catch(() => {});
				await service.close();
			})();
			return closing;
		},
	};
}

/** Production wiring is explicit; tests pass a faux runtime, temporary database and fake senders. */
export async function startApplication(
	options: Parameters<typeof startMessaging>[0] & {
		web?: false | { host?: string; port?: number };
		services?: boolean;
		automation?: boolean;
	},
) {
	const messaging = await startMessaging({ ...options, autostart: false });
	let workers: Awaited<ReturnType<typeof createServices>> | undefined;
	let automation: ReturnType<typeof createAutomationService> | undefined;
	let web: Awaited<ReturnType<typeof startWeb>> | undefined;
	let closing: Promise<void> | undefined;
	function close() {
		closing ??= (async () => {
			// Stop producers and execution together: a worker may be awaiting a model result.
			const results = await Promise.allSettled([
				web?.close(),
				workers?.close(),
				automation?.stop(),
				messaging.close(),
			]);
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		})();
		return closing;
	}
	try {
		if (options.services !== false)
			workers = await createServices({ workingDir: options.workingDir, agent: messaging });
		if (workers) messaging.install(workers.extension);
		if (options.automation !== false)
			automation = createAutomationService({
				workingDir: options.workingDir,
				notify: async (chatGuid, text, requestId) => {
					const receipt = await messaging.sendDirect({ chatGuid, text, requestId });
					if (receipt.textStatus !== "sent") throw new Error("Automation notification outcome unknown");
				},
			});
		if (options.web !== false)
			web = await startWeb({
				workingDir: options.workingDir,
				agent: messaging,
				scheduled: workers?.api,
				automation: () => ({ tasks: automation?.list() ?? [], runs: automation?.listRuns() ?? [] }),
				...options.web,
			});
		messaging.start();
		workers?.start();
		automation?.start();
		return { messaging, workers, automation, web, close };
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}
