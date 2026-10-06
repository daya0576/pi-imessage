import { access, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const templates = fileURLToPath(new URL("../examples/workspace-extensions/", import.meta.url));

/** Offline configuration migration only. Never opens or rewrites Durable storage. */
export async function migrateWorkspaceExtensions(workingDir) {
	try {
		await access(join(workingDir, "durable", "owner.lock"));
		throw new Error("Stop the owning service and verify lock release before migration");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const settingsPath = join(workingDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	if (!settings || typeof settings !== "object" || Array.isArray(settings))
		throw new Error("Invalid settings");
	const agentsPath = join(workingDir, "AGENTS.md");
	const agents = await readFile(agentsPath, "utf8").catch((error) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	const additions = [];
	if (settings.scheduledEnglish) {
		const legacy = settings.scheduledEnglish;
		if (
			typeof legacy.enabled !== "boolean" ||
			typeof legacy.chatGuid !== "string" ||
			!legacy.chatGuid.trim() ||
			typeof legacy.historyFile !== "string" ||
			!legacy.historyFile.startsWith("/") ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(legacy.time ?? "07:45")
		)
			throw new Error("Invalid legacy scheduledEnglish");
		additions.push([
			"workplace-english",
			{
				...legacy,
				id: "henry-work-english-expressions",
				time: legacy.time ?? "07:45",
				policy: {
					reviewIntervals: [1, 3, 7, 14, 30],
					effectiveFrom: "2026-10-04",
					maxReviews: 2,
					dailyLimit: 3,
					windowDays: 30,
					maxNew: 10,
					minNewGapDays: 3,
				},
			},
		]);
	}
	additions.push([
		"system-context",
		{ summaryFile: "SYSTEM.md", maxBytes: 8192, boundary: "<!-- END SYSTEM SUMMARY -->" },
	]);
	const pending = [];
	for (const [name, config] of additions) {
		try {
			await access(join(workingDir, "extensions", name));
			// Existing operator-owned code/configuration always wins on repeated migration.
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			pending.push([name, config]);
		}
	}
	const marker = "## Workspace system records";
	const instructions = `${marker}\n\nMaintain SYSTEM.md as a compact current configuration summary (target <=4 KiB), not a work log. After environment modifications (packages, environment variables, configuration or dependencies), update the relevant summary and append dated details to system-history/YYYY-MM-DD.md. Keep <!-- END SYSTEM SUMMARY --> at the summary boundary. Read history only when needed; it is not current state. The system-context workspace extension loads the configured summary file within its byte limit.\n`;
	const needsPolicy = settings.modelPolicy === undefined;
	if (!pending.length && !needsPolicy && agents.includes(marker)) return { changed: false };
	const backup = join(workingDir, "workspace-migration-backups", `${Date.now()}`);
	await mkdir(backup, { recursive: true, mode: 0o700 });
	for (const name of ["settings.json", "AGENTS.md", "SYSTEM.md", "extensions"]) {
		try {
			await cp(join(workingDir, name), join(backup, name), {
				recursive: true,
				errorOnExist: true,
				force: false,
			});
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	for (const [name, config] of pending) {
		const target = join(workingDir, "extensions", name);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		const staging = join(dirname(target), `.${name}.migration-${Date.now()}`);
		await cp(join(templates, name), staging, { recursive: true, force: false, errorOnExist: true });
		await writeFile(join(staging, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600 });
		await writeFile(join(staging, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
		await rename(staging, target);
	}
	if (needsPolicy) {
		// Preserve the previously selected runtime policy explicitly, not as framework defaults.
		settings.modelPolicy = {
			fallback: { provider: "openai-codex", modelId: "gpt-6-astra" },
			codexServiceTier: "priority",
		};
		const staging = `${settingsPath}.migration`;
		await writeFile(staging, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(staging, settingsPath);
	}
	if (!agents.includes(marker))
		await writeFile(agentsPath, `${agents.trimEnd()}\n\n${instructions}`, { mode: 0o600 });
	return { changed: true, backup, extensions: pending.map(([name]) => name) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 4 || process.argv[2] !== "--apply")
		throw new Error(
			"Usage: node ops/migrate-workspace-extensions.mjs --apply WORKING_DIR (service must be stopped)",
		);
	const result = await migrateWorkspaceExtensions(resolve(process.argv[3]));
	console.log(JSON.stringify(result));
}
