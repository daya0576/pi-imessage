import { join } from "node:path";
import type { Message, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { renderSystemMessageUpdate } from "@earendil-works/pi-ai/utils/text";
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

/**
 * Without mid-conversation system support, pi-ai merges later system messages into the leading one,
 * so a changed section rewrites the whole cached prefix. Keep the leading message as first sent and
 * carry later section changes as a user message at their place; tool deltas stay system (ADR 0057).
 */
export function inlinePromptUpdates(messages: Message[]): Message[] {
	let leading = true;
	return messages.flatMap((message): Message[] => {
		if (message.role !== "system") return [message];
		if (leading) {
			leading = false;
			return [message];
		}
		const { content, sections, ...tools } = message;
		const text = renderSystemMessageUpdate({ ...message, toolsAdded: undefined, toolsRemoved: undefined });
		if (!text) return [message];
		const update: Message = {
			role: "user",
			content: `<prompt_update>\nHost update to the system prompt, not a message from the user.\n\n${text}\n</prompt_update>`,
			timestamp: message.timestamp,
		};
		return tools.toolsAdded?.length || tools.toolsRemoved?.length
			? [{ ...tools, content: "" }, update]
			: [update];
	});
}

/** A live configuration getter applies tier changes to subsequent requests only. */
export function withModelPolicy(models: Models, policy: () => Settings["modelPolicy"]): Models {
	return new Proxy(models, {
		get(target, key) {
			if (key === "streamSimple") {
				const streamSimple: Models["streamSimple"] = (model, original, options) => {
					const compat = model.compat;
					const context =
						compat && "supportsMidConvoSystemMessages" in compat && compat.supportsMidConvoSystemMessages
							? original
							: { ...original, messages: inlinePromptUpdates(original.messages) };
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
