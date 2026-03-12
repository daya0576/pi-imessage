/**
 * Sid — iMessage friend entry point.
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentManager } from "./agent.js";
import { createBBClient, createBBMonitor, createRawMessageQueue } from "./bluebubble/index.js";
import { createIMessageBot } from "./imessage.js";
import { createAppLogger, createDigestLogger } from "./logger.js";
import { createMessageSender } from "./send.js";
import { readSettings, writeSettings } from "./settings.js";
import type { Settings } from "./settings.js";
import { createChatStore } from "./store.js";
import { createWebServer } from "./web/index.js";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`[sid] Missing required env var: ${name}`);
		process.exit(1);
	}
	return value;
}

async function main() {
	const blueBubblesUrl = requireEnv("BLUEBUBBLES_URL");
	const blueBubblesPassword = requireEnv("BLUEBUBBLES_PASSWORD");
	const blueHost = process.env.BLUE_HOST || "localhost";
	const port = Number.parseInt(process.env.BLUE_PORT || "7749", 10);
	const webHost = process.env.WEB_HOST || "localhost";
	const webPort = Number.parseInt(process.env.WEB_PORT || "7750", 10);
	const workingDir = process.env.WORKING_DIR || join(homedir(), ".pi", "imessage");

	// Loggers must be created before anything else so all console output is captured.
	const appLogger = createAppLogger(workingDir);
	const digestLogger = createDigestLogger(workingDir);

	const blueBubblesClient = createBBClient({ url: blueBubblesUrl, password: blueBubblesPassword });
	let settings = readSettings(workingDir);
	const getSettings = (): Settings => {
		settings = readSettings(workingDir);
		return settings;
	};
	const agent = await createAgentManager({ workingDir });
	const store = createChatStore({ workingDir });
	const queue = createRawMessageQueue();
	const monitor = createBBMonitor({ host: blueHost, port, queue });
	const setSettings = (updated: Settings): void => {
		settings = updated;
		writeSettings(workingDir, updated);
	};

	const sender = createMessageSender();

	const bot = createIMessageBot({ queue, agent, sender, blueBubblesClient, store, getSettings, digestLogger });
	const web = createWebServer({ workingDir, host: webHost, port: webPort, getSettings, setSettings });

	console.log(`[sid] workspace:  ${workingDir}`);
	monitor.start();
	bot.start();
	web.start();

	let shuttingDown = false;
	async function shutdown() {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log("[sid] Shutting down…");
		bot.stop();
		await Promise.all([web.stop(), monitor.stop()]);
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
