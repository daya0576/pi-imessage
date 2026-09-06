/** Lightweight live check for the currently configured default AI model. */

import type { UserMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

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
	const modelRuntimePromise = ModelRuntime.create({
		authPath: `${agentDir}/auth.json`,
		modelsPath: `${agentDir}/models.json`,
	});

	return async (): Promise<ModelHealthResult> => {
		const startedAt = Date.now();
		let modelLabel: string | null = null;

		try {
			const modelRuntime = await modelRuntimePromise;
			await modelRuntime.refresh();
			const settings = SettingsManager.create(workingDir, agentDir);
			const provider = settings.getDefaultProvider();
			const modelId = settings.getDefaultModel();
			if (!provider || !modelId) throw new Error("No default model configured");

			const model = modelRuntime.getModel(provider, modelId);
			modelLabel = `${provider}/${modelId}`;
			if (!model) throw new Error(`Default model not found: ${modelLabel}`);

			console.log(`[health] model check start: ${modelLabel}`);
			const message: UserMessage = {
				role: "user",
				content: "Reply with exactly OK.",
				timestamp: Date.now(),
			};
			const response = await modelRuntime.complete(
				model,
				{ messages: [message] },
				{
					maxTokens: 64,
					maxRetries: 0,
					timeoutMs: CHECK_TIMEOUT_MS,
					signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
				}
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage || `Model stopped with reason: ${response.stopReason}`);
			}
			const text = response.content
				.filter((part): part is Extract<(typeof response.content)[number], { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim();
			if (text !== "OK") throw new Error(`Model health probe expected OK, received ${JSON.stringify(text)}`);

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
