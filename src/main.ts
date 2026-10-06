import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, type Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	type AgentDefaults,
	Chats,
	chatConversation,
	type MessageInput,
	submitMessage,
	WatchCursor,
} from "./agent/chats.ts";
import { compactionReply, isCommand, runCommand } from "./agent/commands.ts";
import { compactChats } from "./agent/compaction.ts";
import { deliverReplies, recoverSending, type SendText } from "./agent/deliver.ts";
import { type DirectSendInput, deliverDirect } from "./agent/direct-send.ts";
import { openHarness } from "./agent/harness.ts";
import { submitHealth } from "./agent/health.ts";
import { openModels, readDefaults, requestSettings, withModelPolicy } from "./agent/models.ts";
import { startProgress } from "./agent/progress.ts";
import { loadPrompt } from "./agent/prompt.ts";
import { Runs, runRecord } from "./agent/run.ts";
import { deliverScheduled, EXECUTION_KIND, Schedules, schedulingExtension } from "./agent/scheduling.ts";
import { isReplyEnabled, readSettings } from "./config/settings.ts";
import { memoryExtension } from "./extensions/memory.ts";
import { messageExtension } from "./extensions/message.ts";
import { ImageRead } from "./extensions/read-image.ts";
import { validateSchedules, type WorkspaceExtension } from "./extensions/schedules.ts";
import { Subagent } from "./extensions/subagent.ts";
import { webExtension } from "./extensions/web.ts";
import { loadWorkspaceExtensions, workspaceExtension } from "./extensions/workspace.ts";
import { archiveAttachments } from "./transport/attachments.ts";
import { openHttpTransport } from "./transport/http.ts";
import type { MessageSender } from "./transport/send.ts";
import { createWatcher } from "./transport/watch.ts";
import { startWeb } from "./web/server.ts";

/** Explicit startup; pass an isolated runtime in tests instead of opening installed auth. */
export async function startService(
	options: {
		workingDir: string;
		agentDir: string;
		runtime?: { models: Models; defaults: AgentDefaults };
		/** Explicit operator startup request; a stable ID prevents replay after restart. */
		runScheduled?: { jobId: string; requestId: string };
		/** Optional tool selection for isolated callers; rebuilt at startup and on /reload. */
		extensions?: () => readonly Extension[] | Promise<readonly Extension[]>;
		send: SendText;
		sendAttachment: MessageSender["sendAttachment"];
	},
	/** The application owns process HTTP resources; standalone callers retain their transport. */
	reloadHttpTransport?: () => Promise<void>,
) {
	let runtime = options.runtime;
	let modelPolicy = (await readSettings(options.workingDir)).modelPolicy;
	// Installed auth and models; an isolated test runtime has nothing to reload.
	let installed: Awaited<ReturnType<typeof openModels>> | undefined;
	if (!runtime) {
		installed = await openModels(options.agentDir);
		runtime = {
			models: installed,
			defaults: await readDefaults(installed, options.workingDir, options.agentDir, modelPolicy),
		};
	}
	const defaults = { ...runtime.defaults, model: { ...runtime.defaults.model } };
	if (!runtime.models.getModel(defaults.model.provider, defaults.model.modelId))
		throw new Error(`Model is unavailable: ${defaults.model.provider}/${defaults.model.modelId}`);
	async function loadExtensions(): Promise<WorkspaceExtension[]> {
		const extensions = [
			await loadPrompt(options.workingDir, options.agentDir),
			...(!options.extensions
				? [
						messageExtension({
							async owner(id) {
								const chats = (await harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items ?? [];
								const runs = (await harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items ?? [];
								const chatGuid = [...chats, ...runs].find((item) => item.conversationId === id)?.chatGuid;
								if (!chatGuid) throw new Error("No destination chat for send_message");
								return chatGuid;
							},
							send: (input) => service.sendDirect(input),
						}),
					]
				: []),
			// ImageRead replaces CodingTools.read, while text reads still use the native tool.
			...(options.extensions
				? await options.extensions()
				: [
						CodingTools,
						ImageRead,
						await memoryExtension(options.workingDir),
						webExtension(),
						Subagent,
						workspaceExtension(reload),
					]),
			...(await loadWorkspaceExtensions(options.workingDir)),
		];
		validateSchedules(extensions);
		const names = new Set<string>();
		for (const extension of extensions) {
			if (names.has(extension.name)) throw new Error(`Duplicate extension name: ${extension.name}`);
			names.add(extension.name);
		}
		// ADR 0039: an interrupted tool reruns on recovery unless it declares `unsafe`.
		return extensions.map((extension) =>
			extension.tools
				? { ...extension, tools: extension.tools.map((tool) => ({ ...tool, replay: tool.replay ?? "safe" })) }
				: extension,
		);
	}
	const settings = SettingsManager.create(options.workingDir, options.agentDir);
	let activeExtensions: readonly WorkspaceExtension[] = await loadExtensions();
	const owner = await openHarness(
		options.workingDir,
		withModelPolicy(runtime.models, () => modelPolicy),
		activeExtensions,
		requestSettings(settings),
	);
	const { harness, storage } = owner;
	const scheduling = schedulingExtension(harness, defaults);
	let progress: Awaited<ReturnType<typeof startProgress>>;
	try {
		if (owner.registry.snapshot().extension(scheduling.extension.name))
			throw new Error(`Duplicate extension name: ${scheduling.extension.name}`);
		owner.registry.install(scheduling.extension);
		for (const { record } of (await harness.inspect(BACKGROUND_CONTEXT)).tasks) {
			const task = owner.registry.snapshot().task(record.kind);
			if (
				!task ||
				task.definition.version < record.version ||
				(task.definition.version > record.version && !task.definition.migrate)
			)
				throw new Error(`Missing definition or migration for unfinished task: ${record.kind}`);
		}
		// Refuse missing business code needed by an admitted occurrence, not disabled sleeping schedules.
		const savedSchedules = await harness.snapshot(Schedules, BACKGROUND_CONTEXT);
		for (const { record } of (await harness.inspect(BACKGROUND_CONTEXT)).tasks) {
			if (record.kind !== EXECUTION_KIND) continue;
			const input = record.input;
			const jobId = input && typeof input === "object" && !Array.isArray(input) ? input.jobId : undefined;
			const saved = savedSchedules?.items.find((schedule) => schedule.id === jobId);
			if (
				saved &&
				saved.id !== "compact-chats" &&
				!activeExtensions.some((extension) =>
					extension.schedules?.some((schedule) => schedule.id === saved.id),
				)
			)
				throw new Error(`Missing extension for unfinished schedule: ${saved.id}`);
		}
		await scheduling.initialize(activeExtensions);
		if (options.runScheduled)
			await scheduling.runOnce(options.runScheduled.jobId, options.runScheduled.requestId);
		await recoverSending(harness);
		progress = await startProgress(harness, options.workingDir, {
			sendMessage: options.send,
			sendAttachment: options.sendAttachment,
		});
	} catch (error) {
		await owner.close();
		throw error;
	}

	let reloading = Promise.resolve();
	function reload() {
		const operation = reloading.then(reloadResources);
		reloading = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Running calls keep the code they started with; later requests and new chats use the reloaded state. */
	async function reloadResources() {
		const nextPolicy = (await readSettings(options.workingDir)).modelPolicy;
		const nextDefaults = installed
			? await readDefaults(installed, options.workingDir, options.agentDir, nextPolicy)
			: defaults;
		const next = await loadExtensions();
		const activeNames = new Set(activeExtensions.map((extension) => extension.name));
		const unfinishedTasks = (await harness.inspect(BACKGROUND_CONTEXT)).tasks;
		// Retain removed task code conservatively: an already running call can still admit children.
		const retained = activeExtensions.flatMap((extension) => {
			const replacement = next.find((item) => item.name === extension.name);
			const tasks = extension.tasks?.filter(
				(task) => !replacement?.tasks?.some((current) => current.definition.name === task.definition.name),
			);
			if (!tasks?.length) return [];
			if (replacement) {
				next[next.indexOf(replacement)] = { ...replacement, tasks: [...(replacement.tasks ?? []), ...tasks] };
				return [];
			}
			return [{ name: extension.name, tasks }];
		});
		const candidate = createRegistry();
		const names = new Set<string>();
		for (const extension of [
			...owner.registry
				.snapshot()
				.installed()
				.filter((extension) => !activeNames.has(extension.name)),
			...retained,
			...next,
		]) {
			if (names.has(extension.name)) throw new Error(`Duplicate extension name: ${extension.name}`);
			names.add(extension.name);
			candidate.install(extension);
		}
		// Old running tools may admit tasks after inspection; changed versions still need migrations.
		for (const previous of owner.registry.snapshot().tasks()) {
			const task = candidate.snapshot().task(previous.definition.name);
			if (
				task &&
				(task.definition.version < previous.definition.version ||
					(task.definition.version > previous.definition.version && !task.definition.migrate))
			)
				throw new Error(`Missing migration for unfinished task or late child: ${previous.definition.name}`);
		}
		for (const { record } of unfinishedTasks) {
			const task = candidate.snapshot().task(record.kind);
			if (
				!task ||
				task.definition.version < record.version ||
				(task.definition.version > record.version && !task.definition.migrate)
			)
				throw new Error(`Missing definition or migration for unfinished task: ${record.kind}`);
		}
		// A failed business initializer rolls back all schedule/configuration changes before publication.
		await reloadHttpTransport?.();
		await settings.reload();
		await scheduling.initialize(next);
		Object.assign(defaults, nextDefaults);
		modelPolicy = nextPolicy;
		// Validation is complete; synchronous publication leaves running invocations untouched.
		for (const extension of activeExtensions) owner.registry.uninstall(extension);
		for (const extension of [...retained, ...next]) owner.registry.install(extension);
		activeExtensions = [...retained, ...next];
		console.log(new Date().toISOString(), "Agent reloaded", { model: defaults.model });
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
		async health() {
			const started = Date.now();
			const submission = await track(() => submitHealth(harness, defaults));
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
					let text = result.reply;
					if (result.wait !== undefined) {
						const { outcome } = (await harness.waitForTask(result.wait, BACKGROUND_CONTEXT)).state;
						const id = outcome.status === "completed" ? outcome.result.submissionId : undefined;
						const placement =
							id === undefined
								? undefined
								: await (await harness.submission(id, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
						text = compactionReply(outcome, placement);
					}
					if (text)
						await deliverDirect(
							harness,
							{ chatGuid: snapshot.chatGuid, requestId: `command:${snapshot.guid}`, text },
							{ sendMessage: options.send, sendAttachment: options.sendAttachment },
						);
				};
				// A long command (compaction) must not hold the watcher; its reply follows the task.
				if (result.wait === undefined) await reply();
				else void track(reply).catch((error) => console.warn("Command reply failed", snapshot.guid, error));
				return result;
			});
		},
		/**
		 * Immediate tool sends bypass reply allowlists. What was attempted is recorded once in the chat
		 * conversation, so a later reply there has its context.
		 */
		sendDirect(input: DirectSendInput) {
			const snapshot = { ...input };
			return track(async () => {
				const receipt = await deliverDirect(harness, snapshot, {
					sendMessage: options.send,
					sendAttachment: options.sendAttachment,
				});
				const parts = [
					receipt.textStatus === "sent" || receipt.textStatus === "unknown"
						? `[sent message, ${receipt.textStatus}]\n${receipt.text}`
						: undefined,
					receipt.fileStatus === "sent" || receipt.fileStatus === "unknown"
						? `[sent file, ${receipt.fileStatus}] ${receipt.filePath}`
						: undefined,
				].filter((part) => part !== undefined);
				if (parts.length > 0)
					await (await chatConversation(harness, defaults, receipt.chatGuid)).submit(
						{
							type: "write",
							requestId: `direct:${receipt.requestId}`,
							entry: runRecord(parts.join("\n"), Date.now()),
						},
						BACKGROUND_CONTEXT,
					);
				return receipt;
			});
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
					async (chatGuid, text) => {
						await progress.flush();
						await options.send(chatGuid, text, settings.richText);
					},
					(chatGuid) => isReplyEnabled(settings, chatGuid),
				);
				await deliverScheduled(
					harness,
					(input) => service.sendDirect(input),
					(chatGuid) => isReplyEnabled(settings, chatGuid),
				);
			});
		},
		close() {
			closed = true;
			closing ??= (async () => {
				await Promise.allSettled([...operations]);
				await progress.close();
				await owner.close();
			})();
			return closing;
		},
	};
	console.log(new Date().toISOString(), "Agent ready", { model: defaults.model });
	return service;
}

/** One host poll loop for incoming rows and saved replies; Durable owns model execution. */
export async function startMessaging(
	options: Parameters<typeof startService>[0] & {
		dbPath: string;
		intervalMs?: number;
		/** Defer polling/resume until the application is ready. */
		autostart?: boolean;
		onError(error: unknown): void;
	},
	reloadHttpTransport?: () => Promise<void>,
) {
	const intervalMs = options.intervalMs ?? 2000;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Invalid messaging poll interval");
	const service = await startService(options, reloadHttpTransport);
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
		// Resume once, after application initialization; Durable owns recovery.
		service.harness.resume();
		started = true;
		timer = setTimeout(tick, 0);
		console.log(new Date().toISOString(), "Messaging ready", {
			cursor: watcher.cursor,
			intervalMs,
			scheduling: "durable-background-tasks",
		});
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
		health: service.health,
		sendDirect(input: DirectSendInput) {
			if (closed) return Promise.reject(new Error("Messaging is closed"));
			return service.sendDirect(input);
		},
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

/** Production wiring is explicit; tests pass a faux runtime, temporary database and fake senders. */
export async function startApplication(
	options: Parameters<typeof startMessaging>[0] & {
		web?: false | { host?: string; port?: number };
	},
) {
	console.log(new Date().toISOString(), "Application starting", {
		pid: process.pid,
		node: process.version,
		workingDir: options.workingDir,
	});
	// Initialize before model/auth refresh. Injected runtimes keep control of process transport.
	const httpSettings = options.runtime
		? undefined
		: SettingsManager.create(options.workingDir, options.agentDir);
	const transport = httpSettings
		? openHttpTransport({
				proxy: httpSettings.getGlobalSettings().httpProxy,
				idleTimeoutMs: httpSettings.getHttpIdleTimeoutMs(),
			})
		: undefined;
	async function reloadHttpTransport() {
		if (!transport || !httpSettings) return;
		await httpSettings.reload();
		transport.reload({
			proxy: httpSettings.getGlobalSettings().httpProxy,
			idleTimeoutMs: httpSettings.getHttpIdleTimeoutMs(),
		});
	}
	let messaging: Awaited<ReturnType<typeof startMessaging>> | undefined;
	let web: Awaited<ReturnType<typeof startWeb>> | undefined;
	let closing: Promise<void> | undefined;
	function close() {
		closing ??= (async () => {
			const results = await Promise.allSettled([web?.close(), messaging?.close()]);
			// Messaging and Harness work have stopped before draining/releasing HTTP resources.
			await transport?.close();
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			console.log(new Date().toISOString(), "Application resources closed");
		})();
		return closing;
	}
	try {
		messaging = await startMessaging({ ...options, autostart: false }, reloadHttpTransport);
		if (options.web !== false) {
			web = await startWeb({
				workingDir: options.workingDir,
				agent: messaging,
				...options.web,
			});
			console.log(new Date().toISOString(), "Web server listening", {
				host: web.address.address,
				port: web.address.port,
			});
		} else console.log(new Date().toISOString(), "Web server disabled");
		messaging.start();
		console.log(new Date().toISOString(), "Application started");
		return { messaging, web, close };
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}
