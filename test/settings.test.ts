import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
		await writeFile(join(directory, "settings.json"), "{broken");
		expect(isReplyEnabled(await readSettings(directory), "chat")).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
