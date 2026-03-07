/**
 * Blue — iMessage bot entry point.
 */

import "dotenv/config";
import { join } from "node:path";
import { createAgentManager } from "./agent.js";
import { createBBClient, createBBMonitor, createRawMessageQueue } from "./bluebubble/index.js";
import { createIMessageBot } from "./imessage.js";
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
	const workingDir = process.env.WORKING_DIR || join(process.cwd(), "data");

	const blueBubblesClient = createBBClient({ url: blueBubblesUrl, password: blueBubblesPassword });
	const agent = createAgentManager({ workingDir });
	const store = createChatStore({ workingDir });
	const queue = createRawMessageQueue();
	const monitor = createBBMonitor({ port, queue });

	let settings = readSettings(workingDir);
	const getSettings = (): Settings => settings;
	const setSettings = (updated: Settings): void => {
		settings = updated;
		writeSettings(workingDir, updated);
	};

	const bot = createIMessageBot({ queue, agent, blueBubblesClient, store, getSettings });
	const web = createWebServer({ workingDir, port: webPort, getSettings, setSettings });

	console.log(`[blue] Working directory: ${workingDir}`);
	monitor.start();
	bot.start();
	web.start();

	function shutdown() {
		console.log("[blue] Shutting down…");
		bot.stop();
		web.stop();
		monitor.stop();
		process.exit(0);
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error("[blue] Fatal:", error);
	process.exit(1);
});
