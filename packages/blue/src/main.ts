/**
 * Blue — iMessage bot entry point.
 */

import { join } from "node:path";
import { createAgentManager } from "./agent.js";
import { createBBClient } from "./bb.js";
import { createBlueServer } from "./server.js";
import { createStore } from "./store.js";

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) {
		console.error(`[blue] Missing required env var: ${name}`);
		process.exit(1);
	}
	return val;
}

async function main() {
	const bbUrl = requireEnv("BLUEBUBBLES_URL");
	const bbPassword = requireEnv("BLUEBUBBLES_PASSWORD");
	const port = Number.parseInt(process.env.BLUE_PORT || "7749", 10);
	const dataDir = process.env.BLUE_DATA_DIR || join(process.cwd(), "data");

	const bb = createBBClient({ url: bbUrl, password: bbPassword });
	const store = createStore(dataDir);
	const agent = createAgentManager({ store, bb });
	const server = createBlueServer({ port, agent });

	server.start();
}

main().catch((err) => {
	console.error("[blue] Fatal:", err);
	process.exit(1);
});
