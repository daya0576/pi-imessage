/**
 * iMessage bot — wires BlueBubbles monitor → agent → BlueBubbles client.
 *
 *   BB webhook → filter → onMessage → agent.processMessage → BBClient.sendMessage
 */

import type { AgentManager } from "./agent.js";
import { createBBMonitor, createSelfEchoFilter } from "./bluebubble/index.js";
import type { BBClient } from "./bluebubble/index.js";

export interface IMessageBotConfig {
	port: number;
	agent: AgentManager;
	blueBubblesClient: BBClient;
}

/** An inbound message from a specific iMessage chat. */
export interface IMessage {
	chatGuid: string;
	text: string;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { port, agent, blueBubblesClient } = config;
	const echoFilter = createSelfEchoFilter();

	async function handleMessage(msg: IMessage): Promise<void> {
		if (echoFilter.isEcho(msg.chatGuid, msg.text)) {
			console.log(`[blue] drop self-echo ${msg.chatGuid}: ${msg.text.substring(0, 40)}`);
			return;
		}

		console.log(`[blue] <- ${msg.chatGuid}: ${msg.text.substring(0, 80)}`);

		const reply = await agent.processMessage(msg.chatGuid, msg.text);
		if (!reply) return;

		echoFilter.remember(msg.chatGuid, reply);
		console.log(`[blue] -> ${msg.chatGuid}: ${reply.substring(0, 80)}`);
		await blueBubblesClient.sendMessage(msg.chatGuid, reply);
		console.log(`[blue] ✓ sent to ${msg.chatGuid}`);
	}

	const monitor = createBBMonitor({
		port,
		onMessage(chatGuid, text) {
			handleMessage({ chatGuid, text }).catch((error) => {
				console.error(`[blue] Failed to handle message for ${chatGuid}:`, error);
			});
		},
	});

	return {
		start: monitor.start.bind(monitor),
		stop: monitor.stop.bind(monitor),
	};
}
