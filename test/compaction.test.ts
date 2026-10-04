import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { startService } from "../src/main.ts";

// #33: host scheduling stays quiet, native no-ops do not infer, and admission failures preserve context.
it("schedules quiet native compaction, skips empty/reset chats and preserves context on failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-compact-"));
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	try {
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const send = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		agent = await startService({
			workingDir: directory,
			agentDir: join(directory, "agent"),
			runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
			extensions: () => [],
			send,
			sendAttachment: vi.fn(),
		});
		expect(await agent.compact()).toEqual([]);
		faux.setResponses([fauxAssistantMessage("Short answer")]);
		const record = await (
			await agent.submit({ chatGuid: "chat", guid: "question", text: "Short question" })
		).wait(BACKGROUND_CONTEXT);
		const conversation = await agent.harness.conversation(record.conversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error("Missing conversation");
		const before = await conversation.context(BACKGROUND_CONTEXT);
		const tasks = await agent.compact();
		expect(tasks).toHaveLength(1);
		await agent.harness.waitForTask(tasks[0], BACKGROUND_CONTEXT);
		expect(faux.state.callCount).toBe(1);
		expect(await conversation.context(BACKGROUND_CONTEXT)).toEqual(before);
		expect(send).not.toHaveBeenCalled();
		vi.spyOn(agent.harness, "conversation").mockResolvedValueOnce(conversation);
		vi.spyOn(conversation, "compact").mockRejectedValueOnce(new Error("fixture admission failure"));
		expect(await agent.compact()).toEqual([]);
		expect(warn).toHaveBeenCalledWith("Scheduled compaction admission failed", "chat", expect.any(Error));
		expect(await conversation.context(BACKGROUND_CONTEXT)).toEqual(before);
		await conversation.reset(undefined, BACKGROUND_CONTEXT);
		expect(await agent.compact()).toEqual([]);
	} finally {
		await agent?.close();
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	}
});
