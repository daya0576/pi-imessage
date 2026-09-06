import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { openAiCodexFastExtension } from "../agent.js";

type BeforeRequestHandler = (event: { payload: unknown }, ctx: { model?: { provider: string; id: string } }) => unknown;

describe("openAiCodexFastExtension", () => {
	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"])(
		"injects priority service tier for %s",
		(modelId) => {
			let handler: BeforeRequestHandler | undefined;
			const pi = {
				on: (_event: string, registered: BeforeRequestHandler) => {
					handler = registered;
				},
			} as unknown as ExtensionAPI;

			openAiCodexFastExtension(pi);
			expect(handler).toBeDefined();
			expect(handler?.({ payload: { input: "hello" } }, { model: { provider: "openai-codex", id: modelId } })).toEqual({
				input: "hello",
				service_tier: "priority",
			});
		}
	);

	it("does not alter requests for other models", () => {
		let handler: BeforeRequestHandler | undefined;
		const pi = {
			on: (_event: string, registered: BeforeRequestHandler) => {
				handler = registered;
			},
		} as unknown as ExtensionAPI;

		openAiCodexFastExtension(pi);
		expect(
			handler?.({ payload: { input: "hello" } }, { model: { provider: "openai-codex", id: "gpt-5.5" } })
		).toBeUndefined();
	});
});
