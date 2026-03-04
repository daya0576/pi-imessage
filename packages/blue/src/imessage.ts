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

/** An inbound message from a specific iMessage chat (DM or group). */
export interface IMessage {
	chatGuid: string;
	text: string;
	sender: string;
	isGroup: boolean;
	/** Display name of the group chat. Empty string for DMs. */
	groupName: string;
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

		const chatType = msg.isGroup ? "GROUP" : "DM";
		const inLabel = msg.isGroup
			? `[${chatType}] ${msg.groupName}|${msg.sender}`
			: `[${chatType}] ${msg.sender}`;
		console.log(`[blue] <- ${inLabel}: ${msg.text.substring(0, 80)}`);

		// In group chats, prepend the sender so the LLM knows who is speaking.
		const agentText = msg.isGroup ? `[${msg.sender}] ${msg.text}` : msg.text;

		// Call LLM model and agent loop to get a reply.
		const reply = await agent.processMessage(msg.chatGuid, agentText);
		if (!reply) return;

		const outLabel = msg.isGroup ? `[${chatType}] ${msg.groupName}` : `[${chatType}] ${msg.sender}`;
		console.log(`[blue] -> ${outLabel}: ${reply.substring(0, 80)}`);
		echoFilter.remember(msg.chatGuid, reply);
		await blueBubblesClient.sendMessage(msg.chatGuid, reply);
	}

	const monitor = createBBMonitor({
		port,
		onMessage(chatGuid, text, sender, isGroup, groupName) {
			handleMessage({ chatGuid, text, sender, isGroup, groupName }).catch((error) => {
				console.error(`[blue] Failed to handle message for ${chatGuid}:`, error);
			});
		},
	});

	return {
		start: monitor.start.bind(monitor),
		stop: monitor.stop.bind(monitor),
	};
}
