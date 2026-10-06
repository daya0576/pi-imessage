import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Settings = {
	chatAllowlist: { whitelist: string[]; blacklist: string[] };
	richText: { enabled: boolean; markdown: boolean };
	progressMessages: boolean;
	/** No fallback or priority tier is selected unless explicitly configured. */
	modelPolicy: {
		fallback?: { provider: string; modelId: string };
		codexServiceTier?: "default" | "priority";
	};
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
	const value = raw.modelPolicy ?? {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid modelPolicy");
	const policy = value as Record<string, unknown>;
	const modelPolicy: Settings["modelPolicy"] = {};
	if (policy.fallback !== undefined) {
		const fallback = policy.fallback as Record<string, unknown> | null;
		if (
			!fallback ||
			typeof fallback.provider !== "string" ||
			!fallback.provider.trim() ||
			typeof fallback.modelId !== "string" ||
			!fallback.modelId.trim()
		)
			throw new Error("modelPolicy.fallback requires provider and modelId");
		modelPolicy.fallback = { provider: fallback.provider, modelId: fallback.modelId };
	}
	if (policy.codexServiceTier !== undefined) {
		if (policy.codexServiceTier !== "default" && policy.codexServiceTier !== "priority")
			throw new Error("Invalid modelPolicy.codexServiceTier");
		modelPolicy.codexServiceTier = policy.codexServiceTier;
	}
	return {
		// Preserve opaque workspace-owned settings in read-only configuration projections.
		...raw,
		modelPolicy,
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
