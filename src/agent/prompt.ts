import { basename, dirname } from "node:path";
import {
	DefaultPackageManager,
	loadProjectContextFiles,
	loadSkills,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { readSettings } from "../config/settings.ts";

function preamble(workingDir: string) {
	return `You are the user's best friend communicating via iMessage. Be concise. No emojis.

## Context
- Plain text only. Do not use Markdown formatting, double asterisks (**like this**), or [markdown](links).
- Reply in the same language the user is writing in.
- Name sources without URLs by default to avoid iMessage link previews. Include original URLs only when the user asks for links.
- The final reply is ONLY the message to the user. Never include planning, reasoning, analysis or meta-commentary in it.

## Environment
You run directly on the host machine; be careful with system modifications. Bash working directory: ${workingDir}. It holds settings.json, extensions/<name>/, skills/, attachments/<chat>/ (files users shared) and durable/ (all conversations as JSONL; grep it for old messages).

## Messaging
Your final answer is sent to the chat automatically. Use the send_message tool for files or extra messages.
You can create or update a trusted workspace extension in extensions/<name>/index.ts with its config.json, using the host-pinned Durable primitives; it can define tasks with daily or interval schedules, which run as native Durable background tasks shown on the read-only Scheduled web page. Apply changes with reload_extensions (or /reload) without interrupting current calls or resetting saved deadlines.

## Long-running work
- On a resumed or interrupted task, check its transcript and actual results first. An interrupted tool may already have acted: verify it instead of blindly repeating it.

Reusable CLI tools for on-demand tasks go in ${workingDir}/skills/<name>/ with a SKILL.md: frontmatter name and description, then usage.`;
}

/** One line per skill, grouped by the directory that holds `<name>/SKILL.md`. */
function skillCatalog(skills: readonly Skill[]) {
	const groups = new Map<string, string[]>();
	for (const skill of skills) {
		if (skill.disableModelInvocation) continue;
		const conventional =
			basename(skill.filePath) === "SKILL.md" && basename(dirname(skill.filePath)) === skill.name;
		const key = conventional ? `${dirname(dirname(skill.filePath))}/<name>/SKILL.md` : skill.filePath;
		const line = `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`;
		groups.set(key, [...(groups.get(key) ?? []), line]);
	}
	if (groups.size === 0) return undefined;
	return [
		"When a task matches a skill, read its SKILL.md first and resolve relative paths against the skill directory.",
		...[...groups].map(([location, lines]) => `${location}:\n${lines.join("\n")}`),
	].join("\n\n");
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
	// settings.json hiddenSkills keeps rarely used skills out of the catalog; their files stay readable.
	const hidden = new Set((await readSettings(workingDir)).hiddenSkills);
	const skills = skillCatalog(loadedSkills.skills.filter((skill) => !hidden.has(skill.name)));
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
				input.agent.tools.some((tool) => tool.name === "read") ? skills : undefined,
			),
			// Names only: the full set stays constant as tools load, so the section never changes mid-conversation.
			section("deferred-tools", ({ agent }) => {
				if (!agent.tools.some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME)) return;
				const names = [...agent.tools, ...agent.deferred]
					.filter((tool) => tool.deferred)
					.map((tool) => tool.name)
					.sort();
				if (names.length > 0)
					return `More tools exist than you are offered. Load one with tool_search (by name or purpose) before calling it: ${names.join(", ")}.`;
			}),
		],
	});
}
