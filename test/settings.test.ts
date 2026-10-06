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
		const scheduledEnglish = {
			enabled: true,
			chatGuid: "chat",
			historyFile: join(directory, "used.json"),
			time: "07:45",
		};
		await writeFile(join(directory, "settings.json"), JSON.stringify({ scheduledEnglish }));
		expect((await readSettings(directory)).scheduledEnglish).toEqual(scheduledEnglish);
		for (const invalid of [
			{ ...scheduledEnglish, time: "25:00" },
			{ ...scheduledEnglish, historyFile: "relative.json" },
			{ ...scheduledEnglish, chatGuid: "" },
		]) {
			await writeFile(join(directory, "settings.json"), JSON.stringify({ scheduledEnglish: invalid }));
			await expect(readSettings(directory)).rejects.toThrow("scheduledEnglish");
		}
		await writeFile(join(directory, "settings.json"), "{broken");
		expect(isReplyEnabled(await readSettings(directory), "chat")).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
