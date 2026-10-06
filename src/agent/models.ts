import { join } from "node:path";
import type { Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { HarnessSettings } from "@earendil-works/pi-durable";
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
export function requestSettings(settings: SettingsManager): Pick<HarnessSettings, "stream" | "retry"> {
	return {
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
