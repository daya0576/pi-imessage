import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Settings = {
	chatAllowlist: { whitelist: string[]; blacklist: string[] };
	richText: { enabled: boolean; markdown: boolean };
	progressMessages: boolean;
	/** Native daily job; configuration is applied at service startup. */
	scheduledEnglish?: { enabled: boolean; chatGuid: string; time: string; historyFile: string };
};

export async function readSettings(workingDir: string): Promise<Settings> {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(await readFile(join(workingDir, "settings.json"), "utf8")) ?? {};
	} catch (error) {
		if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const allowlist = raw.chatAllowlist as Partial<Settings["chatAllowlist"]> | undefined;
	const richText = raw.richText as Partial<Settings["richText"]> | undefined;
	let scheduledEnglish: Settings["scheduledEnglish"];
	if (raw.scheduledEnglish !== undefined) {
		const value = raw.scheduledEnglish;
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid scheduledEnglish setting");
		const job = value as Record<string, unknown>;
		const time = job.time ?? "07:45";
		if (
			typeof job.enabled !== "boolean" ||
			typeof job.chatGuid !== "string" ||
			!job.chatGuid.trim() ||
			typeof job.historyFile !== "string" ||
			!job.historyFile.startsWith("/") ||
			typeof time !== "string" ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
		)
			throw new Error("scheduledEnglish requires enabled, chatGuid, absolute historyFile and HH:MM time");
		scheduledEnglish = { enabled: job.enabled, chatGuid: job.chatGuid, historyFile: job.historyFile, time };
	}
	return {
		...(scheduledEnglish ? { scheduledEnglish } : {}),
		progressMessages: raw.progressMessages === true,
		chatAllowlist: {
			whitelist: Array.isArray(allowlist?.whitelist)
				? allowlist.whitelist.filter((v) => typeof v === "string")
				: [],
			blacklist: Array.isArray(allowlist?.blacklist)
				? allowlist.blacklist.filter((v) => typeof v === "string")
				: ["*"],
		},
		richText: {
			enabled: typeof richText?.enabled === "boolean" ? richText.enabled : false,
			markdown: typeof richText?.markdown === "boolean" ? richText.markdown : true,
		},
	};
}

export function isReplyEnabled(settings: Settings, chatGuid: string): boolean {
	const { whitelist, blacklist } = settings.chatAllowlist;
	if (blacklist.includes(chatGuid)) return false;
	if (whitelist.includes(chatGuid)) return true;
	return !blacklist.includes("*") && whitelist.includes("*");
}
