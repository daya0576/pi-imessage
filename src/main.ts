/**
 * Sid — iMessage friend entry point.
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentManager } from "./agent.js";
import { createAutomationNotifier } from "./automation-send.js";
import { createAutomationService } from "./automation.js";
import { type CronJobConfig, createCronService } from "./cron.js";
import { createIMessageBot } from "./imessage.js";
import { createAppLogger, createDigestLogger } from "./logger.js";
import { createModelHealthChecker } from "./model-health.js";
import { createAsyncQueue } from "./queue.js";
import { createReminderService } from "./reminders.js";
import { createSelfEchoFilter } from "./self-echo.js";
import { checkEnvironment, createMessageSender } from "./send.js";
import { readSettings, writeSettings } from "./settings.js";
import type { Settings } from "./settings.js";
import { createChatStore } from "./store.js";
import type { IncomingMessage } from "./types.js";
import { createWatcher } from "./watch.js";
import { createWebServer } from "./web/index.js";

async function main() {
	const webEnabled = process.env.WEB_ENABLED !== "false";
	const workerEnabled = process.env.WORKER_ENABLED !== "false";
	const webHost = process.env.WEB_HOST || "localhost";
	const webPort = Number.parseInt(process.env.WEB_PORT || "7750", 10);
	const workingDir = process.env.WORKING_DIR || join(homedir(), ".pi", "imessage");

	// Loggers must be created before anything else so all console output is captured.
	const appLogger = createAppLogger(workingDir);
	const digestLogger = createDigestLogger(workingDir);

	// Pre-flight: ensure Messages.app is running and iMessage is active.
	await checkEnvironment();

	const sender = createMessageSender();
	const echoFilter = createSelfEchoFilter();
	const getSettings = (): Settings => readSettings(workingDir);
	const setSettings = (updated: Settings): void => writeSettings(workingDir, updated);
	const agent = await createAgentManager({ workingDir });
	const checkModelHealth = createModelHealthChecker(workingDir);
	const store = createChatStore({ workingDir });
	const queue = createAsyncQueue<IncomingMessage>(join(workingDir, "queue.json"));
	const watcher = createWatcher({ queue });
	const bot = createIMessageBot({ queue, agent, sender, echoFilter, store, getSettings, digestLogger });
	const reminders = createReminderService({
		workingDir,
		deliver: async (reminder) => {
			echoFilter.remember(reminder.chatGuid, reminder.text);
			await sender.sendMessage(reminder.chatGuid, reminder.text);
		},
	});

	async function executeCronJob(job: CronJobConfig, signal: AbortSignal): Promise<void> {
		const action = job.action;
		if (action.type === "send") {
			echoFilter.remember(action.chatGuid, action.text);
			await sender.sendMessage(action.chatGuid, action.text);
			return;
		}
		if (action.type === "prompt") {
			await agent.processMessage(
				{
					chatGuid: action.chatGuid,
					sender: `cron:${job.id}`,
					text: action.prompt,
					messageType: "imessage",
					groupName: "",
					replyToText: null,
					attachments: [],
					images: [],
				},
				async (reply) => {
					if (reply.kind !== "assistant") return;
					echoFilter.remember(action.chatGuid, reply.text);
					await sender.sendMessage(action.chatGuid, reply.text);
				},
				{ streamingBehavior: "followUp" }
			);
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const [command, ...args] = action.argv;
			if (!command) {
				reject(new Error("exec action has no command"));
				return;
			}
			const child = spawn(command, args, {
				cwd: action.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				signal,
			});
			let output = "";
			const collect = (chunk: Buffer) => {
				output = `${output}${chunk.toString()}`.slice(-16_000);
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			child.on("error", reject);
			child.on("exit", (code, childSignal) => {
				if (code === 0) {
					if (output.trim()) console.log(`[cron] ${job.id} output: ${output.trim()}`);
					resolve();
				} else {
					reject(new Error(`command exited code=${code ?? "null"} signal=${childSignal ?? "none"}: ${output.trim()}`));
				}
			});
		});
	}

	const cron = createCronService({ workingDir, execute: executeCronJob });
	const automation = createAutomationService({
		workingDir,
		notify: createAutomationNotifier(sender, (chatGuid, text) => echoFilter.remember(chatGuid, text)),
	});
	const web = webEnabled
		? createWebServer({
				workingDir,
				host: webHost,
				port: webPort,
				getSettings,
				setSettings,
				sender,
				echoFilter,
				agent,
				checkModelHealth,
				reminders,
				cron,
				automation,
			})
		: null;

	console.log(`[sid] workspace:  ${workingDir}`);
	console.log(`[sid] worker:     ${workerEnabled ? "active" : "shadow"}`);
	if (workerEnabled) {
		watcher.start();
		bot.start();
		reminders.start();
		cron.start();
		automation.start();
	}
	if (web) web.start();

	let shuttingDown = false;
	async function shutdown() {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("[sid] Shutting down…");
		if (workerEnabled) {
			watcher.stop();
			bot.stop();
			await Promise.all([reminders.stop(), cron.stop(), automation.stop()]);
		}
		await Promise.all([web?.stop(), automation.stop()]);
		digestLogger.close();
		appLogger.close();
		console.log("[sid] Shutdown complete");
		process.exit(0);
	}

	process.on("SIGINT", () => shutdown());
	process.on("SIGTERM", () => shutdown());
}

main().catch((error) => {
	console.error("[sid] Fatal:", error);
	process.exit(1);
});
