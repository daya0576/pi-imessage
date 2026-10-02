import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createHeadlessResourceLoader } from "../headless-extensions.js";

it("uses only the enabled shared provider factory and respects its current model policy", async () => {
	const root = mkdtempSync(join(tmpdir(), "shared-provider-"));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	const settingsFile = join(agentDir, "settings.json");
	writeFileSync(settingsFile, JSON.stringify({ extensions: ["!extensions/**", "+extensions/openai-codex-fast.ts"] }));
	// Policy deliberately differs from the removed inline copy: the shared source
	// owns future GPT model matching, and the host must not inject a second hook.
	writeFileSync(
		join(agentDir, "extensions/openai-codex-fast.ts"),
		`export default function(pi) {
		pi.on("before_provider_request", (event, ctx) => {
			if(ctx.model?.provider !== "openai-codex" || !/^gpt-/.test(ctx.model.id)) return;
			if(typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return;
			return {...event.payload, service_tier:"priority"};
		});
	}`
	);
	const loader = createHeadlessResourceLoader({
		cwd: root,
		agentDir,
		sessionDir: join(root, "chat"),
		settingsManager: SettingsManager.create(root, agentDir),
		systemPrompt: "Test",
		log: () => {},
	});
	try {
		await loader.reload();
		const hooks = loader
			.getExtensions()
			.extensions.flatMap((extension) => extension.handlers.get("before_provider_request") ?? []);
		expect(hooks).toHaveLength(1);
		for (const id of ["gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-future"])
			expect(await hooks[0]({ payload: { input: "hello" } }, { model: { provider: "openai-codex", id } })).toEqual({
				input: "hello",
				service_tier: "priority",
			});
		expect(await hooks[0]({ payload: {} }, { model: { provider: "other", id: "gpt-future" } })).toBeUndefined();
		writeFileSync(settingsFile, JSON.stringify({ extensions: ["!extensions/**"] }));
		await loader.reload();
		expect(
			loader.getExtensions().extensions.flatMap((extension) => extension.handlers.get("before_provider_request") ?? [])
		).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
