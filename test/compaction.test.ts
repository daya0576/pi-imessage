import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { compactionReply } from "../src/agent/commands.ts";
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
		// #33: manual no-op reports no work, rather than claiming a summary was applied.
		await agent.command({ chatGuid: "chat", guid: "compact-command", text: "/compact" });
		await vi.waitFor(() => expect(send.mock.calls.map(([, text]) => text)).toEqual(["Nothing to compact."]), {
			timeout: 5000,
		});
		expect(faux.state.callCount).toBe(1);
		// Public receipt fixtures test our reporting, not Durable's summarization/placement guarantees.
		expect(compactionReply({ status: "failed", error: { message: "fixture failure" } })).toBe(
			"Compaction failed.",
		);
		expect(compactionReply({ status: "aborted" })).toBe("Compaction cancelled.");
		if (record.status !== "done" || record.type !== "input") throw new Error("Missing answer");
		expect(compactionReply({ status: "completed", result: { entryId: record.answer } })).toBe("Compacted.");
		const completed = { status: "completed", result: { submissionId: record.id } } as const;
		const placement = { id: record.id, conversationId: record.conversationId, type: "write" } as const;
		expect(compactionReply(completed, { ...placement, status: "done", entry: record.answer })).toBe(
			"Compacted.",
		);
		expect(compactionReply(completed, { ...placement, status: "queued" })).toBe(
			"Compaction summary queued for the next turn boundary.",
		);
		expect(compactionReply(completed, { ...placement, status: "unanswered", reason: "stale" })).toBe(
			"Compaction summary discarded because the context changed.",
		);
		expect(compactionReply(completed, { ...placement, status: "unanswered", reason: "aborted" })).toBe(
			"Compaction summary was not applied.",
		);
		expect(compactionReply(completed)).toBe("Compaction result unavailable.");
		await conversation.reset(undefined, BACKGROUND_CONTEXT);
		expect(await agent.compact()).toEqual([]);
	} finally {
		await agent?.close();
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	}
});
