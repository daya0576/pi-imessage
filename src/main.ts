/**
 * Sid — iMessage friend entry point.
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentManager } from "./agent.js";
import { createIMessageBot } from "./imessage.js";
import { createAppLogger, createDigestLogger } from "./logger.js";
import { createAsyncQueue } from "./queue.js";
import { checkEnvironment, createMessageSender } from "./send.js";
import { readSettings, writeSettings } from "./settings.js";
import type { Settings } from "./settings.js";
import { createChatStore } from "./store.js";
import type { IncomingMessage } from "./types.js";
import { createWatcher } from "./watch.js";
import { createWebServer } from "./web/index.js";

async function main() {
	const webEnabled = process.env.WEB_ENABLED !== "false";
	const webHost = process.env.WEB_HOST || "localhost";
	const webPort = Number.parseInt(process.env.WEB_PORT || "7750", 10);
	const workingDir = process.env.WORKING_DIR || join(homedir(), ".pi", "imessage");

	// Loggers must be created before anything else so all console output is captured.
	const appLogger = createAppLogger(workingDir);
	const digestLogger = createDigestLogger(workingDir);

	// Pre-flight: ensure Messages.app is running and iMessage is active.
	await checkEnvironment();

	const sender = createMessageSender();
	let settings = readSettings(workingDir);
	const getSettings = (): Settings => {
		settings = readSettings(workingDir);
		return settings;
	};
	const agent = await createAgentManager({ workingDir });
	const store = createChatStore({ workingDir });
	const queue = createAsyncQueue<IncomingMessage>();
	const watcher = createWatcher({ queue });
	const setSettings = (updated: Settings): void => {
		settings = updated;
		writeSettings(workingDir, updated);
	};

	const bot = createIMessageBot({ queue, agent, sender, store, getSettings, digestLogger });
	const web = webEnabled
		? createWebServer({ workingDir, host: webHost, port: webPort, getSettings, setSettings })
		: null;

	console.log(`[sid] workspace:  ${workingDir}`);
	watcher.start();
	bot.start();
	if (web) web.start();

	let shuttingDown = false;
	async function shutdown() {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("[sid] Shutting down…");
		watcher.stop();
		bot.stop();
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
