/**
 * Blue — iMessage bot entry point.
 */

import "dotenv/config";
import { join } from "node:path";
import { createAgentManager } from "./agent.js";
import { createBBClient } from "./bluebubble/index.js";
import { createIMessageBot } from "./imessage.js";

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
	const workingDir = process.env.WORKING_DIR || join(process.cwd(), "data");

	const blueBubblesClient = createBBClient({ url: blueBubblesUrl, password: blueBubblesPassword });
	const agent = createAgentManager({ workingDir });
	const bot = createIMessageBot({ port, agent, blueBubblesClient });

	console.log(`[blue] Working directory: ${workingDir}`);
	bot.start();
}

main().catch((error) => {
	console.error("[blue] Fatal:", error);
	process.exit(1);
});
