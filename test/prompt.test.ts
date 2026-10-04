import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { expect, it, vi } from "vitest";
import { Chats } from "../src/agent/chats.ts";
import { startService } from "../src/main.ts";

// #33: product resources stay stable until /reload; skills and references are read by real tools, not injected whole.
it("loads AGENTS and installed user skills, then refreshes their prompt sections on /reload", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-prompt-"));
	const agentDir = join(directory, "agent");
	const packageDir = join(directory, "polish-package");
	const skillDir = join(packageDir, "zblog-polish");
	const skillPath = join(skillDir, "SKILL.md");
	const referencePath = join(skillDir, "references", "style.md");
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	try {
		await mkdir(join(skillDir, "references"), { recursive: true });
		await mkdir(agentDir);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
		);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
		await writeFile(join(agentDir, "AGENTS.md"), "Global fixture instructions.");
		await writeFile(join(directory, "AGENTS.md"), "Workspace instructions v1.");
		await writeFile(
			join(directory, "SYSTEM.md"),
			"Current system v1.\n<!-- END SYSTEM SUMMARY -->\nHIDDEN HISTORY",
		);
		await writeFile(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "prompt-fixture", pi: { skills: ["zblog-polish"], extensions: ["unsafe.ts"] } }),
		);
		await writeFile(join(packageDir, "unsafe.ts"), 'throw new Error("SDK extensions must not execute");');
		const skill = (version: string) =>
			`---\nname: zblog-polish\ndescription: Polish fixture ${version}\n---\nRead references/style.md before polishing.`;
		await writeFile(skillPath, skill("v1"));
		await writeFile(referencePath, "Reference style v1.");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const extensions = vi.fn(() => [CodingTools]);
		const send = vi.fn().mockResolvedValue(undefined);
		agent = await startService({
			workingDir: directory,
			agentDir,
			runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
			extensions,
			send,
			sendAttachment: vi.fn().mockRejectedValue(new Error("Unexpected attachment send")),
		});
		faux.setResponses([
			(context) => {
				const prompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				expect(prompt).toContain("Global fixture instructions.");
				expect(prompt).toContain("Workspace instructions v1.");
				expect(prompt).toContain("Polish fixture v1");
				expect(prompt).toContain("Current system v1.");
				expect(prompt).not.toContain("HIDDEN HISTORY");
				expect(prompt).not.toContain("Read references/style.md");
				return fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Read references/style.md");
				return fauxAssistantMessage(fauxToolCall("read", { path: referencePath }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Reference style v1.");
				return fauxAssistantMessage("Polished v1.");
			},
		]);
		await (await agent.submit({ chatGuid: "chat", guid: "first", text: "Polish this paragraph." })).wait(
			BACKGROUND_CONTEXT,
		);
		const chat = (await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items[0];
		if (!chat) throw new Error("Missing chat");
		const conversation = await agent.harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error("Missing conversation");
		const systemEntries = async () =>
			(await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter((entry) =>
				entry.model?.some(
					(message) => message.role === "system" && message.sections?.project_context !== undefined,
				),
			);
		expect(await systemEntries()).toHaveLength(1);
		await writeFile(join(directory, "AGENTS.md"), "Workspace instructions v2.");
		await writeFile(join(directory, "SYSTEM.md"), "Current system v2.");
		await writeFile(skillPath, skill("v2"));
		await writeFile(referencePath, "Reference style v2.");
		faux.setResponses([fauxAssistantMessage("Still cached.")]);
		await (await agent.submit({ chatGuid: "chat", guid: "cached", text: "One more." })).wait(
			BACKGROUND_CONTEXT,
		);
		expect(await systemEntries()).toHaveLength(1);
		expect(extensions).toHaveBeenCalledTimes(1);
		await agent.command({ chatGuid: "chat", guid: "reload", text: "/reload" });
		expect(extensions).toHaveBeenCalledTimes(2);
		faux.setResponses([
			(context) => {
				const changes = context.messages.filter((message) => message.role === "system");
				const latest = JSON.stringify(
					changes.findLast((message) => message.sections?.project_context)?.sections,
				);
				expect(latest).toContain("Workspace instructions v2.");
				expect(latest).toContain("Polish fixture v2");
				expect(latest).toContain("Current system v2.");
				return fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" });
			},
			() => fauxAssistantMessage(fauxToolCall("read", { path: referencePath }), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Reference style v2.");
				return fauxAssistantMessage("Polished v2.");
			},
		]);
		const settled = await (
			await agent.submit({ chatGuid: "chat", guid: "refreshed", text: "Polish again." })
		).wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		expect(await systemEntries()).toHaveLength(2);
		expect(faux.state.callCount).toBe(7);
		// No automatic message or model work is started by resource loading itself.
		expect(send.mock.calls.map(([, text]) => text)).toEqual([expect.stringContaining("Reloaded.")]);
	} finally {
		await agent?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
