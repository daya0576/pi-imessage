/**
 * Settings — workspace-level configuration for the iMessage bot.
 *
 * Loaded from ~/.pi/imessage/settings.json (or WORKING_DIR/settings.json).
 *
 * ### Chat allowlist
 *
 * Controls whether the bot should reply to a given chat.
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
 *
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ChatAllowlist {
	whitelist: string[];
	blacklist: string[];
}

export interface RichTextSettings {
	enabled: boolean;
	markdown: boolean;
}

export interface Settings {
	chatAllowlist: ChatAllowlist;
	richText?: RichTextSettings;
}

const DEFAULT_CHAT_ALLOWLIST: ChatAllowlist = { whitelist: [], blacklist: ["*"] };
const DEFAULT_RICH_TEXT: RichTextSettings = { enabled: false, markdown: true };
const DEFAULT_SETTINGS: Settings = { chatAllowlist: DEFAULT_CHAT_ALLOWLIST, richText: DEFAULT_RICH_TEXT };

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
		const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
		const chatAllowlistRaw = (raw.chatAllowlist ?? {}) as Partial<ChatAllowlist>;

		const richTextRaw = (raw.richText ?? {}) as Partial<RichTextSettings>;

		return {
			chatAllowlist: {
				whitelist: Array.isArray(chatAllowlistRaw.whitelist)
					? chatAllowlistRaw.whitelist
					: DEFAULT_CHAT_ALLOWLIST.whitelist,
				blacklist: Array.isArray(chatAllowlistRaw.blacklist)
					? chatAllowlistRaw.blacklist
					: DEFAULT_CHAT_ALLOWLIST.blacklist,
			},
			richText: {
				enabled: typeof richTextRaw.enabled === "boolean" ? richTextRaw.enabled : DEFAULT_RICH_TEXT.enabled,
				markdown: typeof richTextRaw.markdown === "boolean" ? richTextRaw.markdown : DEFAULT_RICH_TEXT.markdown,
			},
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function writeSettings(workingDir: string, settings: Settings): void {
	writeFileSync(settingsPath(workingDir), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}
