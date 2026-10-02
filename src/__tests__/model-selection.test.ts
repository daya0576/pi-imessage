import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { modelFailureNotice, resolveDefaultModel } from "../model-selection.js";

type Model = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
const model = { provider: "github-copilot", id: "claude-opus-4.8-fast" } as Model;
const astra = { provider: "openai-codex", id: "gpt-6-astra" } as Model;
function runtime(primaryFound = true, primaryAuth = true, fallbackFound = true, fallbackAuth = true) {
	let refreshed = false;
	return {
		refresh: vi.fn(async () => {
			refreshed = true;
		}),
		getModel: vi.fn((provider: string, id: string) => {
			if (!refreshed) return undefined;
			if (provider === model.provider && id === model.id) return primaryFound ? model : undefined;
			if (provider === astra.provider && id === astra.id) return fallbackFound ? astra : undefined;
			throw new Error("unexpected model selection");
		}),
		hasConfiguredAuth: vi.fn((provider: string) => (provider === model.provider ? primaryAuth : fallbackAuth)),
	};
}
describe("Astra-only selection fallback", () => {
	it("refreshes a stale registry and keeps the exact available Copilot default", async () => {
		const r = runtime();
		expect(await resolveDefaultModel(r, model.provider, model.id)).toBe(model);
		expect(r.getModel).toHaveBeenCalledTimes(1);
	});
	it.each([
		[false, true],
		[true, false],
	])("uses Astra when default missing/auth unavailable: %s %s", async (found, auth) => {
		expect(await resolveDefaultModel(runtime(found, auth), model.provider, model.id)).toBe(astra);
	});
	it.each([
		[false, true],
		[true, false],
	])("fails closed when Astra missing/auth unavailable: %s %s", async (found, auth) => {
		await expect(resolveDefaultModel(runtime(false, false, found, auth), model.provider, model.id)).rejects.toThrow(
			"备用模型"
		);
	});
	it.each([
		[undefined, undefined],
		["github-copilot", undefined],
	])("uses Astra for incomplete defaults", async (provider, id) => {
		expect(await resolveDefaultModel(runtime(), provider, id)).toBe(astra);
	});
	it("propagates refresh failure without selecting a stale model", async () => {
		const r = runtime();
		r.refresh.mockRejectedValue(new Error("refresh failed"));
		await expect(resolveDefaultModel(r, model.provider, model.id)).rejects.toThrow("refresh failed");
		expect(r.getModel).not.toHaveBeenCalled();
	});
	it("keeps timeout variants internal even when retry attempts are exhausted", () => {
		for (const error of [
			"Request timed out.",
			"APIConnectionTimeoutError",
			"connect ETIMEDOUT",
			"504 Gateway Time-out",
		])
			expect(modelFailureNotice("error", model, error)).toBeUndefined();
		expect(modelFailureNotice("error", model, "Unauthorized: private fixture detail")).toBe(
			`模型 ${model.provider}/${model.id} 生成失败。`
		);
	});
	it("reports failed generation without retrying or flagging cancellation", () => {
		expect(modelFailureNotice("error", model)).toContain(`${model.provider}/${model.id}`);
		expect(modelFailureNotice("stop", model)).toBeUndefined();
		expect(modelFailureNotice("aborted", model)).toBeUndefined();
	});
});
