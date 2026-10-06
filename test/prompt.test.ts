import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { expect, it, vi } from "vitest";
import { Chats } from "../src/agent/chats.ts";
import { startService } from "../src/main.ts";

// #33: resources and request policy stay cached until /reload; Durable executes tools and retries.
it("loads skills and request settings, then refreshes resources and native policy on /reload", async () => {
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
		const contextDir = join(directory, "extensions/system-context");
		await mkdir(contextDir, { recursive: true });
		await cp("examples/workspace-extensions/system-context/index.ts", join(contextDir, "index.ts"));
		await writeFile(join(contextDir, "package.json"), '{"type":"commonjs"}');
		await writeFile(
			join(contextDir, "config.json"),
			JSON.stringify({ summaryFile: "SYSTEM.md", boundary: "<!-- END SYSTEM SUMMARY -->", maxBytes: 8192 }),
		);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
		);
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [packageDir],
				httpIdleTimeoutMs: 2500,
				transport: "websocket",
				retry: {
					enabled: false,
					maxRetries: 1,
					baseDelayMs: 1,
					provider: { timeoutMs: 1234, maxRetries: 0, maxRetryDelayMs: 17 },
				},
			}),
		);
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
		const stream = vi.spyOn(models, "streamSimple");
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
				// #33 / ADR 0019: the prompt must not advertise retired scheduling entry points.
				expect(prompt).not.toContain("POST /reminders");
				expect(prompt).not.toContain("/cron/jobs.json");
				expect(prompt).toContain("create or update a trusted workspace extension");
				expect(prompt).not.toContain("For every environment modification");
				expect(prompt).toContain("Include original URLs only when the user asks for links");
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
		expect(stream.mock.calls[0][2]).toMatchObject({
			transport: "sse",
			timeoutMs: 1234,
			maxRetries: 0,
			maxRetryDelayMs: 17,
		});
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [packageDir],
				httpIdleTimeoutMs: 0,
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					maxAgentDelayMs: 20,
					provider: { maxRetries: 2, maxRetryDelayMs: 27 },
				},
			}),
		);
		await writeFile(join(directory, "AGENTS.md"), "Workspace instructions v2.");
		await writeFile(join(directory, "SYSTEM.md"), "Current system v2.");
		await writeFile(skillPath, skill("v2"));
		await writeFile(referencePath, "Reference style v2.");
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit fixture" }),
		]);
		const cached = await (await agent.submit({ chatGuid: "chat", guid: "cached", text: "One more." })).wait(
			BACKGROUND_CONTEXT,
		);
		expect(cached).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect(faux.state.callCount).toBe(4); // Cached disabled retry is honored despite the changed file.
		expect(stream.mock.calls[3][2]).toMatchObject({ timeoutMs: 1234, maxRetries: 0, maxRetryDelayMs: 17 });
		expect(await systemEntries()).toHaveLength(1);
		expect(extensions).toHaveBeenCalledTimes(1);
		await agent.command({ chatGuid: "chat", guid: "reload", text: "/reload" });
		expect(extensions).toHaveBeenCalledTimes(2);
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit fixture" }),
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
		expect(faux.state.callCount).toBe(8); // One native retry, then the skill/reference reads and answer.
		expect(stream.mock.calls[4][2]).toMatchObject({
			transport: "sse",
			timeoutMs: 2_147_483_647,
			maxRetries: 2,
			maxRetryDelayMs: 27,
		});
		expect(stream.mock.calls[5][2]).toMatchObject({ timeoutMs: 2_147_483_647, maxRetries: 2 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit fixture" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit fixture" }),
		]);
		const exhausted = await (
			await agent.submit({ chatGuid: "chat", guid: "exhausted", text: "Retry limit." })
		).wait(BACKGROUND_CONTEXT);
		expect(exhausted).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect(faux.state.callCount).toBe(10); // The configured one-retry cap, not Durable's default cap.
		// No automatic message or model work is started by resource loading itself.
		expect(send.mock.calls.map(([, text]) => text)).toEqual([expect.stringContaining("Reloaded.")]);
	} finally {
		await agent?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
