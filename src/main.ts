/**
 * Sid — iMessage friend entry point.
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentManager } from "./agent.js";
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
			})
		: null;

	console.log(`[sid] workspace:  ${workingDir}`);
	console.log(`[sid] worker:     ${workerEnabled ? "active" : "shadow"}`);
	if (workerEnabled) {
		watcher.start();
		bot.start();
		reminders.start();
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
			await reminders.stop();
		}
		await web?.stop();
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
