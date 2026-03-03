/**
 * Blue — iMessage bot entry point.
 */

import "dotenv/config";
import { createAgentManager } from "./agent.js";
import { createBBClient, createBlueServer } from "./bluebubble/index.js";

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

	const blueBubblesClient = createBBClient({ url: blueBubblesUrl, password: blueBubblesPassword });
	const agent = createAgentManager({ blueBubblesClient });
	const server = createBlueServer({ port, agent });

	server.start();
}

main().catch((error) => {
	console.error("[blue] Fatal:", error);
	process.exit(1);
});
