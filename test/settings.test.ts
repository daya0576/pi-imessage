import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { budgetedWindow, compactionSettings } from "../src/agent/models.ts";
import { isReplyEnabled, readSettings } from "../src/config/settings.ts";

it("reads existing settings without rewriting them and preserves allowlist precedence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-settings-"));
	try {
		expect(isReplyEnabled(await readSettings(directory), "chat")).toBe(false);
		for (const [whitelist, blacklist, expected] of [
			[["*"], [], true],
			[["*"], ["chat"], false],
			[["chat"], ["*"], true],
			[["chat"], ["chat"], false],
			[[], [], false],
		] as const) {
			await writeFile(
				join(directory, "settings.json"),
				JSON.stringify({
					chatAllowlist: { whitelist, blacklist },
					richText: { enabled: true, markdown: false },
					unrelated: "retained",
				}),
			);
			const settings = await readSettings(directory);
			expect(isReplyEnabled(settings, "chat")).toBe(expected);
			expect(settings.richText).toEqual({ enabled: true, markdown: false });
		}
		const modelPolicy = { fallback: { provider: "faux", modelId: "faux-1" }, codexServiceTier: "priority" };
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ modelPolicy, retiredFeature: { untouched: true } }),
		);
		expect((await readSettings(directory)).modelPolicy).toEqual(modelPolicy);
		expect(JSON.parse(JSON.stringify(await readSettings(directory))).retiredFeature).toEqual({
			untouched: true,
		});
		expect(JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))).toHaveProperty(
			"retiredFeature",
		);
		for (const modelPolicy of [
			{ fallback: {} },
			{ fallback: { provider: "", modelId: "x" } },
			{ codexServiceTier: "expensive" },
		]) {
			await writeFile(join(directory, "settings.json"), JSON.stringify({ modelPolicy }));
			await expect(readSettings(directory)).rejects.toThrow("modelPolicy");
		}
		// ADR 0054: a context budget becomes per-model Durable thresholds; exempt models never compact automatically.
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ compaction: { budgetTokens: 160000, exempt: ["faux/long"] } }),
		);
		const budget = (await readSettings(directory)).compaction;
		expect(budget).toEqual({ budgetTokens: 160000, backgroundTokens: 60000, exempt: ["faux/long"] });
		const models = {
			getModels: () => [
				{ provider: "faux", id: "wide", contextWindow: 1_000_000 },
				{ provider: "faux", id: "long", contextWindow: 1_000_000 },
				{ provider: "faux", id: "narrow", contextWindow: 128_000 },
			],
		} as unknown as Models;
		expect(compactionSettings(models, undefined)).toBeUndefined();
		expect(compactionSettings(models, budget)).toMatchObject({
			enabled: true,
			modelOverrides: {
				"faux/wide": { reserveTokens: 840_000, backgroundTokens: 60_000 },
				"faux/long": { enabled: false },
			},
		});
		expect(compactionSettings(models, budget)?.modelOverrides).not.toHaveProperty("faux/narrow");
		expect(budgetedWindow({ provider: "faux", id: "wide", contextWindow: 1_000_000 }, budget)).toBe(160_000);
		expect(budgetedWindow({ provider: "faux", id: "long", contextWindow: 1_000_000 }, budget)).toBe(
			1_000_000,
		);
		expect(budgetedWindow({ provider: "faux", id: "narrow", contextWindow: 128_000 }, budget)).toBe(128_000);
		for (const compaction of [
			{ budgetTokens: 0 },
			{ budgetTokens: 160000, backgroundTokens: 160000 },
			{ budgetTokens: 160000, exempt: ["no-slash"] },
		]) {
			await writeFile(join(directory, "settings.json"), JSON.stringify({ compaction }));
			await expect(readSettings(directory)).rejects.toThrow("compaction");
		}
		await writeFile(join(directory, "settings.json"), "{broken");
		expect(isReplyEnabled(await readSettings(directory), "chat")).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
