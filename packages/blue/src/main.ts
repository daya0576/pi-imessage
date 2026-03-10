/**
 * Blue — iMessage bot entry point.
 */

import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentManager } from "./agent.js";
import { createBBClient, createBBMonitor, createRawMessageQueue } from "./bluebubble/index.js";
import { createIMessageBot } from "./imessage.js";
import { createAppLogger, createDigestLogger } from "./logger.js";
import { readSettings, writeSettings } from "./settings.js";
import type { Settings } from "./settings.js";
import { createChatStore } from "./store.js";
import { createWebServer } from "./web/index.js";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`[blue] Missing required env var: ${name}`);
		process.exit(1);
	}
	return value;
}

async function main() {
	const blueBubblesUrl = requireEnv("BLUEBUBBLES_URL");
	const blueBubblesPassword = requireEnv("BLUEBUBBLES_PASSWORD");
	const port = Number.parseInt(process.env.BLUE_PORT || "7749", 10);
	const webPort = Number.parseInt(process.env.WEB_PORT || "7750", 10);
	const workingDir = process.env.WORKING_DIR || join(homedir(), ".pi", "imessage");

	// Loggers must be created before anything else so all console output is captured.
	const appLogger = createAppLogger(workingDir);
	const digestLogger = createDigestLogger(workingDir);

	const blueBubblesClient = createBBClient({ url: blueBubblesUrl, password: blueBubblesPassword });
	let settings = readSettings(workingDir);
	const agent = createAgentManager({ workingDir, modelSettings: settings.model });
	const store = createChatStore({ workingDir });
	const queue = createRawMessageQueue();
	const monitor = createBBMonitor({ port, queue });
	const getSettings = (): Settings => settings;
	const setSettings = (updated: Settings): void => {
		settings = updated;
		writeSettings(workingDir, updated);
	};

	const bot = createIMessageBot({ queue, agent, blueBubblesClient, store, getSettings, digestLogger });
	const web = createWebServer({ workingDir, port: webPort, getSettings, setSettings });

	const { effectiveModel } = agent;
	console.log(`[blue] workspace:  ${workingDir}`);
	console.log(`[blue] model:      ${effectiveModel.provider}/${effectiveModel.model} (${effectiveModel.source})`);
	monitor.start();
	bot.start();
	web.start();

	function shutdown() {
		console.log("[blue] Shutting down…");
		bot.stop();
		web.stop();
		monitor.stop();
		digestLogger.close();
		appLogger.close();
		process.exit(0);
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error("[blue] Fatal:", error);
	process.exit(1);
});
