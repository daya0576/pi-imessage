import { join } from "node:path";
import type { Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type CompactionPolicy,
	DEFAULT_COMPACTION_POLICY,
	type HarnessSettings,
} from "@earendil-works/pi-durable";
import type { Settings } from "../config/settings.ts";
import type { AgentDefaults } from "./chats.ts";

export function openModels(agentDir: string) {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
}

/** Read defaults and use only an explicitly configured, available fallback. */
export async function readDefaults(
	runtime: ModelRuntime,
	workingDir: string,
	agentDir: string,
	policy: Settings["modelPolicy"] = {},
): Promise<AgentDefaults> {
	const settings = SettingsManager.create(workingDir, agentDir);
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	const thinkingLevel = settings.getDefaultThinkingLevel();
	await runtime.refresh();
	if (provider && modelId && runtime.getModel(provider, modelId) && runtime.hasConfiguredAuth(provider))
		return { model: { provider, modelId }, thinkingLevel };
	const fallback = policy.fallback;
	if (
		!fallback ||
		!runtime.getModel(fallback.provider, fallback.modelId) ||
		!runtime.hasConfiguredAuth(fallback.provider)
	)
		throw new Error(`Default model ${provider}/${modelId} is unavailable; no available configured fallback`);
	console.warn(
		`Default model ${provider}/${modelId} unavailable; using ${fallback.provider}/${fallback.modelId}`,
	);
	return { model: { ...fallback }, thinkingLevel };
}

/** Match Pi's experimental Durable request policy; execution and retries remain native. */
/**
 * Durable thresholds for a context budget (ADR 0054): blocking compaction at the budget and background compaction
 * `backgroundTokens` below it, computed from each known model's window; exempt models never compact automatically.
 */
export function compactionSettings(
	models: Models,
	budget: Settings["compaction"],
): HarnessSettings["compaction"] {
	if (!budget) return undefined;
	const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};
	for (const model of models.getModels()) {
		if (model.contextWindow > budget.budgetTokens)
			modelOverrides[`${model.provider}/${model.id}`] = {
				reserveTokens: model.contextWindow - budget.budgetTokens,
				backgroundTokens: budget.backgroundTokens,
			};
	}
	for (const key of budget.exempt) modelOverrides[key] = { enabled: false };
	return { ...DEFAULT_COMPACTION_POLICY, modelOverrides };
}

/** The window `/status` reports: the budget where it caps a non-exempt model's window. */
export function budgetedWindow(
	model: { provider: string; id: string; contextWindow: number } | undefined,
	budget: Settings["compaction"],
) {
	if (!model) return undefined;
	if (!budget || budget.exempt.includes(`${model.provider}/${model.id}`)) return model.contextWindow;
	return Math.min(model.contextWindow, budget.budgetTokens);
}

export function requestSettings(
	settings: SettingsManager,
	compaction: () => HarnessSettings["compaction"] = () => undefined,
): Pick<HarnessSettings, "stream" | "retry" | "compaction"> {
	return {
		get compaction() {
			return compaction();
		},
		get stream() {
			const provider = settings.getProviderRetrySettings();
			const idle = settings.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get retry() {
			return settings.getRetrySettings();
		},
	};
}

/** A live configuration getter applies tier changes to subsequent requests only. */
export function withModelPolicy(models: Models, policy: () => Settings["modelPolicy"]): Models {
	return new Proxy(models, {
		get(target, key) {
			if (key === "streamSimple") {
				const streamSimple: Models["streamSimple"] = (model, context, options) => {
					const tier = policy().codexServiceTier;
					if (!tier || model.provider !== "openai-codex" || !/^gpt-/.test(model.id))
						return target.streamSimple(model, context, options);
					const configured: ModelsSimpleStreamOptions = {
						...options,
						async onPayload(payload, payloadModel) {
							const current = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
							if (typeof current !== "object" || current === null || Array.isArray(current)) return current;
							return { ...current, service_tier: tier };
						},
					};
					return target.streamSimple(model, context, configured);
				};
				return streamSimple;
			}
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
