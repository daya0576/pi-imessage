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
 * ### Model overrides
 *
 * Optional fields to override the default model from ~/.pi/agent/:
 *   defaultProvider, defaultModel, defaultThinkingLevel
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface ChatAllowlist {
	whitelist: string[];
	blacklist: string[];
}

export interface ModelOverride {
	defaultProvider: string;
	defaultModel: string;
	defaultThinkingLevel?: ThinkingLevel;
}

export interface Settings {
	chatAllowlist: ChatAllowlist;
	/** Optional model override. Undefined means use ~/.pi/agent/ defaults. */
	modelOverride?: ModelOverride;
}

const DEFAULT_CHAT_ALLOWLIST: ChatAllowlist = { whitelist: ["*"], blacklist: [] };
const DEFAULT_SETTINGS: Settings = { chatAllowlist: DEFAULT_CHAT_ALLOWLIST };

const VALID_THINKING_LEVELS: Set<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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

		// Parse model override (all-or-nothing: provider + model must both be present)
		let modelOverride: ModelOverride | undefined;
		if (typeof raw.defaultProvider === "string" && typeof raw.defaultModel === "string") {
			const thinkingLevel =
				typeof raw.defaultThinkingLevel === "string" && VALID_THINKING_LEVELS.has(raw.defaultThinkingLevel)
					? (raw.defaultThinkingLevel as ThinkingLevel)
					: undefined;
			modelOverride = {
				defaultProvider: raw.defaultProvider,
				defaultModel: raw.defaultModel,
				defaultThinkingLevel: thinkingLevel,
			};
		}

		return {
			chatAllowlist: {
				whitelist: Array.isArray(chatAllowlistRaw.whitelist)
					? chatAllowlistRaw.whitelist
					: DEFAULT_CHAT_ALLOWLIST.whitelist,
				blacklist: Array.isArray(chatAllowlistRaw.blacklist)
					? chatAllowlistRaw.blacklist
					: DEFAULT_CHAT_ALLOWLIST.blacklist,
			},
			modelOverride,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function writeSettings(workingDir: string, settings: Settings): void {
	writeFileSync(settingsPath(workingDir), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}
