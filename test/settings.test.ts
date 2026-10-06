import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
		await writeFile(join(directory, "settings.json"), "{broken");
		expect(isReplyEnabled(await readSettings(directory), "chat")).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
