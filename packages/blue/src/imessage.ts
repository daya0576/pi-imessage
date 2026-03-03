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

/** An inbound message from a specific iMessage DM. */
export interface IMessage {
	chatGuid: string;
	text: string;
}

export function createIMessageBot(config: IMessageBotConfig) {
	const { port, agent, blueBubblesClient } = config;
	const echoFilter = createSelfEchoFilter();

	async function handleMessage(msg: IMessage): Promise<void> {
    // Drop agent self-echo messages to prevent infinite loops.
		if (echoFilter.isEcho(msg.chatGuid, msg.text)) {
			console.warn(`[blue] drop self-echo ${msg.chatGuid}: ${msg.text.substring(0, 40)}`);
			return;
		}

		console.log(`[blue] <- ${msg.chatGuid}: ${msg.text.substring(0, 80)}`);

    // Call LLM model and agent loop to get a reply.
		const reply = await agent.processMessage(msg.chatGuid, msg.text);
		if (!reply) return;

    // Reply message
		console.log(`[blue] -> ${msg.chatGuid}: ${reply.substring(0, 80)}`);
		echoFilter.remember(msg.chatGuid, reply);
		await blueBubblesClient.sendMessage(msg.chatGuid, reply);
	}

	const monitor = createBBMonitor({
		port,
		onMessage(chatGuid, text) {
			handleMessage({ chatGuid: chatGuid, text }).catch((error) => {
				console.error(`[blue] Failed to handle message for ${chatGuid}:`, error);
			});
		},
	});

	return {
		start: monitor.start.bind(monitor),
		stop: monitor.stop.bind(monitor),
	};
}
