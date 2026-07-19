/** Lightweight live check for the currently configured default AI model. */

import type { UserMessage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

const CHECK_TIMEOUT_MS = 30_000;

export interface ModelHealthResult {
	ok: boolean;
	model: string | null;
	latencyMs: number;
	checkedAt: string;
	error?: string;
}

export type ModelHealthChecker = () => Promise<ModelHealthResult>;

export function createModelHealthChecker(workingDir: string): ModelHealthChecker {
	const agentDir = getAgentDir();
	const modelRegistry = ModelRegistry.create(AuthStorage.create());

	return async (): Promise<ModelHealthResult> => {
		const startedAt = Date.now();
		let modelLabel: string | null = null;

		try {
			modelRegistry.refresh();
			const settings = SettingsManager.create(workingDir, agentDir);
			const provider = settings.getDefaultProvider();
			const modelId = settings.getDefaultModel();
			if (!provider || !modelId) throw new Error("No default model configured");

			const model = modelRegistry.find(provider, modelId);
			modelLabel = `${provider}/${modelId}`;
			if (!model) throw new Error(`Default model not found: ${modelLabel}`);

			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);

			console.log(`[health] model check start: ${modelLabel}`);
			const message: UserMessage = {
				role: "user",
				content: "Reply with exactly OK.",
				timestamp: Date.now(),
			};
			const response = await complete(
				model,
				{ messages: [message] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 64,
					maxRetries: 0,
					timeoutMs: CHECK_TIMEOUT_MS,
					signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
				}
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage || `Model stopped with reason: ${response.stopReason}`);
			}
			const hasText = response.content.some((part) => part.type === "text" && part.text.trim().length > 0);
			if (!hasText) throw new Error("Model returned no text");

			const result: ModelHealthResult = {
				ok: true,
				model: modelLabel,
				latencyMs: Date.now() - startedAt,
				checkedAt: new Date().toISOString(),
			};
			console.log(`[health] model check ok: ${modelLabel} latency_ms=${result.latencyMs}`);
			return result;
		} catch (error) {
			const result: ModelHealthResult = {
				ok: false,
				model: modelLabel,
				latencyMs: Date.now() - startedAt,
				checkedAt: new Date().toISOString(),
				error: error instanceof Error ? error.message : String(error),
			};
			console.error(
				`[health] model check failed: ${modelLabel ?? "unknown"} latency_ms=${result.latencyMs} error="${result.error}"`
			);
			return result;
		}
	};
}
