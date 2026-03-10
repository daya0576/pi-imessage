/**
 * Settings — whitelist/blacklist based reply control.
 *
 * Determines whether the bot should reply to a given chat.
 * Messages are always logged regardless of this setting.
 *
 * Resolution priority (highest to lowest):
 *
 *   blacklist["chatGuid"]  >  whitelist["chatGuid"]  >  blacklist["*"]  >  whitelist["*"]
 *
 * Examples:
 *   whitelist: ["*"], blacklist: []        → reply to everyone
 *   whitelist: ["1"], blacklist: []        → reply only to "1"
 *   whitelist: ["*"], blacklist: ["2"]     → reply to everyone except "2"
 *   blacklist: ["*"], whitelist: []        → reply to nobody (log-only)
 *   whitelist: ["1"], blacklist: ["*"]     → reply only to "1"
 *   whitelist: ["1"], blacklist: ["1"]     → no reply (blacklist wins)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ChatAllowlist {
	whitelist: string[];
	blacklist: string[];
}

export interface ModelSettings {
	defaultProvider?: string;
	defaultModel?: string;
}

export interface Settings {
	chatAllowlist: ChatAllowlist;
	model?: ModelSettings;
}

const DEFAULT_CHAT_ALLOWLIST: ChatAllowlist = { whitelist: ["*"], blacklist: [] };
const DEFAULT_SETTINGS: Settings = { chatAllowlist: DEFAULT_CHAT_ALLOWLIST };

/**
 * Determine whether the bot should reply to a given chatGuid.
 *
 * Priority: blacklist[chatGuid] > whitelist[chatGuid] > blacklist["*"] > whitelist["*"]
 */
export function isReplyEnabled(settings: Settings, chatGuid: string): boolean {
	const { whitelist, blacklist } = settings.chatAllowlist;
	if (blacklist.includes(chatGuid)) return false;
	if (whitelist.includes(chatGuid)) return true;
	if (blacklist.includes("*")) return false;
	if (whitelist.includes("*")) return true;
	return false;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function settingsPath(workingDir: string): string {
	return join(workingDir, "settings.json");
}

export function readSettings(workingDir: string): Settings {
	const filePath = settingsPath(workingDir);
	if (!existsSync(filePath)) return { ...DEFAULT_SETTINGS };
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<Settings>;
		const chatAllowlist: Partial<ChatAllowlist> = raw.chatAllowlist ?? {};
		const model: ModelSettings | undefined =
			raw.model && typeof raw.model === "object"
				? {
						defaultProvider: typeof raw.model.defaultProvider === "string" ? raw.model.defaultProvider : undefined,
						defaultModel: typeof raw.model.defaultModel === "string" ? raw.model.defaultModel : undefined,
					}
				: undefined;
		return {
			chatAllowlist: {
				whitelist: Array.isArray(chatAllowlist.whitelist) ? chatAllowlist.whitelist : DEFAULT_CHAT_ALLOWLIST.whitelist,
				blacklist: Array.isArray(chatAllowlist.blacklist) ? chatAllowlist.blacklist : DEFAULT_CHAT_ALLOWLIST.blacklist,
			},
			model,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function writeSettings(workingDir: string, settings: Settings): void {
	writeFileSync(settingsPath(workingDir), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}
