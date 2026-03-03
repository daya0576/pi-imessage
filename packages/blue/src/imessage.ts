/**
 * iMessage bot — wires BlueBubbles monitor → agent → BlueBubbles client.
 *
 *   BB webhook → filter → onMessage → agent.processMessage → BBClient.sendMessage
 */

import type { AgentManager } from "./agent.js";
import { createBBMonitor } from "./bluebubble/index.js";
import type { BBClient } from "./bluebubble/index.js";

export interface IMessageBotConfig {
	port: number;
	agent: AgentManager;
	blueBubblesClient: BBClient;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { port, agent, blueBubblesClient } = config;

	const monitor = createBBMonitor({
		port,
		onMessage(chatGuid, text) {
			console.log(`[blue] <- ${chatGuid}: ${text.substring(0, 80)}`);

			agent
				.processMessage(chatGuid, text)
				.then(async (reply) => {
					if (!reply) return;
					console.log(`[blue] -> ${chatGuid}: ${reply.substring(0, 80)}`);
					await blueBubblesClient.sendMessage(chatGuid, reply);
					console.log(`[blue] ✓ sent to ${chatGuid}`);
				})
				.catch((error) => {
					console.error(`[blue] Failed to process message for ${chatGuid}:`, error);
				});
		},
	});

	return {
		start: monitor.start.bind(monitor),
		stop: monitor.stop.bind(monitor),
	};
}
