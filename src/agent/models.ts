import { join } from "node:path";
import type { Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "./chats.ts";

export function openModels() {
	const agentDir = getAgentDir();
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
}

/** Read defaults on every call; the only permitted fallback is Codex Astra. */
export async function readDefaults(runtime: ModelRuntime, workingDir: string): Promise<AgentDefaults> {
	const settings = SettingsManager.create(workingDir, getAgentDir());
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	const thinkingLevel = settings.getDefaultThinkingLevel();
	await runtime.refresh();
	if (provider && modelId && runtime.getModel(provider, modelId) && runtime.hasConfiguredAuth(provider))
		return { model: { provider, modelId }, thinkingLevel };
	if (!runtime.getModel("openai-codex", "gpt-6-astra") || !runtime.hasConfiguredAuth("openai-codex"))
		throw new Error(
			`Default model ${provider}/${modelId} and fallback openai-codex/gpt-6-astra are unavailable`,
		);
	console.warn(`Default model ${provider}/${modelId} unavailable; using openai-codex/gpt-6-astra`);
	return { model: { provider: "openai-codex", modelId: "gpt-6-astra" }, thinkingLevel };
}

/** Codex GPT models run in the priority (fast) service tier. */
export function withCodexFast(models: Models): Models {
	return new Proxy(models, {
		get(target, key) {
			if (key === "streamSimple") {
				const streamSimple: Models["streamSimple"] = (model, context, options) => {
					if (model.provider !== "openai-codex" || !/^gpt-/.test(model.id))
						return target.streamSimple(model, context, options);
					const fast: ModelsSimpleStreamOptions = {
						...options,
						async onPayload(payload, payloadModel) {
							const current = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
							if (typeof current !== "object" || current === null || Array.isArray(current)) return current;
							return { ...current, service_tier: "priority" };
						},
					};
					return target.streamSimple(model, context, fast);
				};
				return streamSimple;
			}
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
