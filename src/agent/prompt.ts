import { constants, open } from "node:fs/promises";
import { join } from "node:path";
import {
	DefaultPackageManager,
	formatSkillsForPrompt,
	loadProjectContextFiles,
	loadSkills,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";

/** Per-file byte budget for SYSTEM.md; dated history is never loaded here. */
const SYSTEM_SUMMARY_MAX_BYTES = 8192;
const SYSTEM_SUMMARY_END = "<!-- END SYSTEM SUMMARY -->";

async function readSystemSummary(workingDir: string) {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(
			join(workingDir, "SYSTEM.md"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		if (!(await file.stat()).isFile()) return "[SYSTEM.md unavailable: expected a regular summary file.]";
		const buffer = Buffer.alloc(SYSTEM_SUMMARY_MAX_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (!result.bytesRead) break;
			bytesRead += result.bytesRead;
		}
		const truncated = bytesRead > SYSTEM_SUMMARY_MAX_BYTES;
		// A streaming decode drops only an incomplete trailing UTF-8 character at the byte boundary.
		const text = new TextDecoder("utf-8", { fatal: true })
			.decode(buffer.subarray(0, Math.min(bytesRead, SYSTEM_SUMMARY_MAX_BYTES)), { stream: truncated })
			.trim();
		const end = text.indexOf(SYSTEM_SUMMARY_END);
		if (end >= 0) return text.slice(0, end).trim();
		return truncated
			? `${text}\n\n[SYSTEM.md exceeded the ${SYSTEM_SUMMARY_MAX_BYTES}-byte summary limit; the rest was not loaded. Keep only current configuration here; history belongs in system-history/YYYY-MM-DD.md.]`
			: text;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		return "[SYSTEM.md summary unavailable.]";
	} finally {
		await file?.close();
	}
}

function preamble(workingDir: string) {
	return `You are the user's best friend communicating via iMessage. Be concise. No emojis.

## Context
- Plain text only. Do not use Markdown formatting, double asterisks (**like this**), or [markdown](links).
- Reply in the same language the user is writing in.
- Output ONLY the final message to the user. Never include planning, reasoning, analysis or meta-commentary in the reply.

## Environment
You are running directly on the host machine.
- Bash working directory: ${workingDir}
- Be careful with system modifications.

## Workspace Layout
${workingDir}/
├── settings.json                # Bot configuration
├── SYSTEM.md                    # Compact current system configuration
├── system-history/              # Dated change logs, read only when needed
├── skills/                      # Your reusable CLI tools; skills/file-memory is the memory store
├── cron/jobs.json               # Recurring jobs
├── attachments/<chat>/          # Files users shared, referenced by path in messages
└── durable/                     # All conversations (JSONL); grep here to search old messages

## System configuration and history
- Maintain ${workingDir}/SYSTEM.md as a compact CURRENT configuration summary, targeting <=4 KiB. It is not a work log.
- For every environment modification (packages, environment variables, config files, dependencies), update the relevant summary entry and append the dated detail to ${workingDir}/system-history/YYYY-MM-DD.md.
- Keep the ${SYSTEM_SUMMARY_END} boundary at the end of the summary. Only the summary is loaded, capped at ${SYSTEM_SUMMARY_MAX_BYTES} bytes; read history on demand and do not treat it as current state.

## Messaging, reminders and recurring jobs
Your final answer is sent to the chat automatically. Use the send_message tool for files or extra messages.

When enabled by the host, the local reminder API is at http://localhost:7750.
POST /reminders schedules a persistent one-time reminder; scheduledAt needs an explicit timezone. Use it instead of one-off scripts or crontab:
curl -X POST http://localhost:7750/reminders -H "Content-Type: application/json" -d '{"chatGuid":"<chatGuid>","text":"check the oven","scheduledAt":"2026-08-08T21:30:00+08:00","idempotencyKey":"check-oven-2026-08-08"}'
curl 'http://localhost:7750/reminders?status=pending'
curl -X DELETE http://localhost:7750/reminders/<reminderId>

Recurring messages or tasks go in ${workingDir}/cron/jobs.json, never crontab. A "send" action sends text as is; a "prompt" action runs the prompt in a fresh task conversation and sends its final answer, which is also recorded in the chat. Either may set "command" (absolute executable plus argv) instead of the text: its stdout becomes the text or prompt, and empty output skips that run. An "exec" action only runs the command.

## Long-running work
- On a resumed or interrupted task, check its transcript and actual results first. An interrupted tool may already have acted: verify it instead of blindly repeating it.

## Skills (custom CLI tools)
Create reusable tools for recurring tasks in ${workingDir}/skills/<name>/, each with a SKILL.md:
---
name: skill-name
description: What this skill does
---
Usage instructions and details here.`;
}

/**
 * The system prompt: product instructions, AGENTS files, skills and SYSTEM.md, read once per load.
 * `/reload` builds it again; the same extension name replaces the old one in place.
 */
export async function loadPrompt(workingDir: string, agentDir: string) {
	const settings = SettingsManager.create(workingDir, agentDir, { projectTrusted: false });
	const packages = new DefaultPackageManager({ cwd: workingDir, agentDir, settingsManager: settings });
	// Discover installed user resources only; never install packages or execute SDK extensions headlessly.
	const resources = await packages.resolve(async (source) => {
		console.warn("Prompt resource unavailable; skipping missing package", source);
		return "skip";
	});
	const agents = loadProjectContextFiles({ cwd: workingDir, agentDir });
	const loadedSkills = loadSkills({
		cwd: workingDir,
		agentDir,
		includeDefaults: false,
		skillPaths: resources.skills
			.filter((resource) => resource.enabled && resource.metadata.scope === "user")
			.map((resource) => resource.path),
	});
	for (const diagnostic of loadedSkills.diagnostics) console.warn("Skill resource diagnostic", diagnostic);
	const skills = formatSkillsForPrompt(loadedSkills.skills, "read").trim();
	const system = await readSystemSummary(workingDir);
	const text = preamble(workingDir);
	return defineExtension({
		name: "prompt",
		sections: [
			section("preamble", () => text, { tag: false }),
			section("project_context", () =>
				agents.length === 0
					? undefined
					: [
							"Project-specific instructions and guidelines:",
							...agents.map(
								({ path, content }) =>
									`<project_instructions path="${path}">\n${content}\n</project_instructions>`,
							),
						].join("\n\n"),
			),
			section("skills", (input) =>
				input.agent.tools.some((tool) => tool.name === "read") ? skills || undefined : undefined,
			),
			section("system_configuration", () => system || undefined),
		],
	});
}
