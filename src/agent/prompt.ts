import {
	DefaultPackageManager,
	formatSkillsForPrompt,
	loadProjectContextFiles,
	loadSkills,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";

function preamble(workingDir: string) {
	return `You are the user's best friend communicating via iMessage. Be concise. No emojis.

## Context
- Plain text only. Do not use Markdown formatting, double asterisks (**like this**), or [markdown](links).
- Reply in the same language the user is writing in.
- Name sources without URLs by default to avoid iMessage link previews. Include original URLs only when the user asks for links.
- Output ONLY the final message to the user. Never include planning, reasoning, analysis or meta-commentary in the reply.

## Environment
You are running directly on the host machine.
- Bash working directory: ${workingDir}
- Be careful with system modifications.

## Workspace Layout
${workingDir}/
├── settings.json                # Bot configuration
├── extensions/<name>/           # Trusted business tools/tasks: index.ts and config.json
├── skills/                      # Your reusable CLI tools; skills/file-memory is the memory store
├── attachments/<chat>/          # Files users shared, referenced by path in messages
└── durable/                     # All conversations (JSONL); grep here to search old messages

## Messaging
Your final answer is sent to the chat automatically. Use the send_message tool for files or extra messages.
Six-hour compaction and workspace extension schedules run as native Durable background tasks. Their deadlines and recent execution records are visible on the read-only Scheduled web page.
For delayed or recurring work, create or update a trusted workspace extension in extensions/<name>/index.ts with its config.json, using the host-pinned Durable primitives. An extension can define multiple tasks and optional daily/interval schedules. Use reload_extensions (or the user command /reload) to apply code and configuration changes without interrupting current calls or resetting saved deadlines. Do not use skills, attachments, detached timers, crontab or a second pipeline as an extension scheduler.

## Long-running work
- On a resumed or interrupted task, check its transcript and actual results first. An interrupted tool may already have acted: verify it instead of blindly repeating it.

## Skills (custom CLI tools)
Create reusable tools for on-demand tasks in ${workingDir}/skills/<name>/, each with a SKILL.md:
---
name: skill-name
description: What this skill does
---
Usage instructions and details here.`;
}

/**
 * The system prompt: product instructions, AGENTS files and skills, read once per load.
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
		],
	});
}
