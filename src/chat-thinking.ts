import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}
function settingsPath(root: string, chatGuid: string): string {
	if (
		!chatGuid ||
		chatGuid === "." ||
		chatGuid === ".." ||
		/[/\\]/.test(chatGuid) ||
		chatGuid.includes(String.fromCharCode(0))
	) {
		throw new Error("Invalid chat identifier");
	}
	return join(root, chatGuid, "agent-settings.json");
}
export function readChatThinking(root: string, chatGuid: string): ThinkingLevel | undefined {
	const path = settingsPath(root, chatGuid);
	if (!existsSync(path)) return undefined;
	const data = JSON.parse(readFileSync(path, "utf8"));
	if (data.thinkingLevel === undefined) return undefined;
	if (!isThinkingLevel(data.thinkingLevel)) throw new Error("Invalid chat thinking level");
	return data.thinkingLevel;
}
export function writeChatThinking(root: string, chatGuid: string, level: ThinkingLevel | undefined): void {
	const path = settingsPath(root, chatGuid);
	if (level !== undefined && !isThinkingLevel(level)) throw new Error("Invalid chat thinking level");
	const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	data.thinkingLevel = level;
	mkdirSync(join(root, chatGuid), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** Only session state is changed. Never persist to Pi's global defaults. */
export function applyChatThinking(
	root: string,
	chatGuid: string,
	session: { setThinkingLevel: (level: ThinkingLevel, options: { persist: boolean }) => void },
	fallback?: ThinkingLevel
): ThinkingLevel | undefined {
	const level = readChatThinking(root, chatGuid) ?? fallback;
	if (level) session.setThinkingLevel(level, { persist: false });
	return level;
}
