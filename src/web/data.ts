/** Read chat logs from disk and produce ChatBlock summaries. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../store.js";

export interface ChatBlock {
	guid: string;
	displayName: string;
	messages: Message[];
	lastTime: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function readMessages(workingDir: string, chatGuid: string): Message[] {
	const logFile = join(workingDir, chatGuid, "log.jsonl");
	if (!existsSync(logFile)) return [];
	const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
	const messages: Message[] = [];
	for (const line of lines) {
		try {
			messages.push(JSON.parse(line) as Message);
		} catch {
			// skip malformed lines
		}
	}
	return messages;
}

/** Return chat blocks from the last 7 days, sorted by most-recent message. */
export function getChatBlocks(workingDir: string): ChatBlock[] {
	if (!existsSync(workingDir)) return [];
	const cutoff = Date.now() - SEVEN_DAYS_MS;
	const blocks: ChatBlock[] = [];

	let entries: string[];
	try {
		entries = readdirSync(workingDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}

	for (const guid of entries) {
		const messages = readMessages(workingDir, guid);
		if (messages.length === 0) continue;
		const lastMessage = messages[messages.length - 1];
		if (!lastMessage) continue;
		const lastTime = new Date(lastMessage.date).getTime();
		if (lastTime < cutoff) continue;

		const parts = guid.split(";");
		let displayName = parts[parts.length - 1] ?? guid;
		if (lastMessage.messageType === "group" && lastMessage.groupName) {
			displayName = lastMessage.groupName;
		}

		blocks.push({ guid, displayName, messages, lastTime });
	}

	blocks.sort((a, b) => b.lastTime - a.lastTime);
	return blocks;
}
