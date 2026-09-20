import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Refresh defaults; the only permitted selection fallback is Codex Astra. */
export async function resolveDefaultModel(
	runtime: Pick<ModelRuntime, "getModel" | "hasConfiguredAuth"> & { refresh(): Promise<unknown> },
	provider: string | undefined,
	modelId: string | undefined
) {
	await runtime.refresh();
	if (provider && modelId) {
		const model = runtime.getModel(provider, modelId);
		if (model && runtime.hasConfiguredAuth(provider)) return model;
	}
	const fallback = runtime.getModel("openai-codex", "gpt-6-astra");
	if (!fallback || !runtime.hasConfiguredAuth("openai-codex")) {
		throw new Error("默认模型不可用，备用模型 openai-codex/gpt-6-astra 也不可用；未切换到其他模型。");
	}
	console.warn(
		`[agent] configured default unavailable: ${provider ?? "unset"}/${modelId ?? "unset"}; fallback=openai-codex/gpt-6-astra`
	);
	return fallback;
}

export function modelFailureNotice(
	stopReason: string,
	model: { provider: string; id: string } | undefined,
	errorMessage?: string
) {
	// Provider/SDK timeout diagnostics belong in logs, including exhausted retries.
	if (stopReason !== "error" || /timed?[\s-]*out|timeout|ETIMEDOUT/i.test(errorMessage ?? "")) return undefined;
	const label = model ? `${model.provider}/${model.id}` : "未知模型";
	// Provider errors can include secrets or request contents; keep details in local logs.
	return `模型 ${label} 生成失败。`;
}
