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
	/**
	 * Context budget compaction (ADR 0054): blocking compaction at `budgetTokens`, background compaction
	 * `backgroundTokens` below it, per model window; `exempt` models (`provider/modelId`) never compact
	 * automatically. Absent: Durable's near-window thresholds and the six-hour timer.
	 */
	compaction?: { budgetTokens: number; backgroundTokens: number; exempt: string[] };
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
	let compaction: Settings["compaction"];
	if (raw.compaction !== undefined) {
		const budget = raw.compaction as Record<string, unknown> | null;
		if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new Error("Invalid compaction");
		const budgetTokens = budget.budgetTokens;
		const backgroundTokens = budget.backgroundTokens ?? 60_000;
		const exempt = budget.exempt ?? [];
		if (typeof budgetTokens !== "number" || !Number.isInteger(budgetTokens) || budgetTokens <= 0)
			throw new Error("compaction.budgetTokens must be a positive integer");
		if (
			typeof backgroundTokens !== "number" ||
			!Number.isInteger(backgroundTokens) ||
			backgroundTokens < 0 ||
			backgroundTokens >= budgetTokens
		)
			throw new Error("compaction.backgroundTokens must be an integer below budgetTokens");
		if (
			!Array.isArray(exempt) ||
			!exempt.every((model) => typeof model === "string" && /^[^/]+\/.+$/.test(model))
		)
			throw new Error("compaction.exempt must list provider/modelId strings");
		compaction = { budgetTokens, backgroundTokens, exempt: exempt as string[] };
	}
	return {
		// Preserve opaque workspace-owned settings in read-only configuration projections.
		...raw,
		...(compaction ? { compaction } : {}),
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
