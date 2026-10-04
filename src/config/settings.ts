import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Settings = {
	chatAllowlist: { whitelist: string[]; blacklist: string[] };
	richText: { enabled: boolean; markdown: boolean };
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
	return {
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
