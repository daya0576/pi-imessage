import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startService } from "../src/main.ts";

let directory: string;
let agent: Awaited<ReturnType<typeof startService>>;
let faux: FauxProviderHandle;
const send = vi.fn().mockResolvedValue(undefined);

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "imessage-subagent-"));
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
	);
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	send.mockClear();
	agent = await startService({
		workingDir: directory,
		agentDir: join(directory, "agent"),
		runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
		send,
		sendAttachment: vi.fn(),
	});
});
afterEach(async () => {
	await agent.close();
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
});

// #33: parent result delivery, child context isolation and our read-only allowlist.
it("delegates into a read-only child and returns only its final text to the parent", async () => {
	await writeFile(join(directory, "fixture.txt"), "child lookup");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", { task: "Read fixture.txt" }), { stopReason: "toolUse" }),
		(context) => {
			const messages = JSON.stringify(context.messages);
			expect(messages).not.toContain("Parent private detail");
			expect(messages).toContain("Read fixture.txt");
			const tools = context.messages
				.filter((message) => message.role === "system")
				.flatMap((message) => message.toolsAdded ?? []);
			expect(tools.map((tool) => tool.name).sort()).toEqual([
				"fetch_content",
				"get_search_results",
				"load_memory",
				"read",
				"search_memory",
				"web_search",
			]);
			return fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });
		},
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("child lookup");
			return fauxAssistantMessage([
				{
					type: "text",
					text: "private commentary",
					textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
				},
				{ type: "text", text: "child answer" },
			]);
		},
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			expect(JSON.stringify(result)).toContain("child answer");
			expect(JSON.stringify(result)).not.toContain("private commentary");
			return fauxAssistantMessage("parent answer");
		},
	]);
	const record = await (
		await agent.submit({
			chatGuid: "chat",
			guid: "parent",
			text: "Parent private detail. Delegate a lookup.",
		})
	).wait(BACKGROUND_CONTEXT);
	expect(record.status).toBe("done");
	await agent.deliver();
	expect(send.mock.calls.map(([, text]) => text)).toEqual(["parent answer"]);
});

// #33: application parent abort is scoped; a child's late answer never goes directly to chat.
it("cancels the foreground child with its parent without cancelling another chat", async () => {
	const started = Promise.withResolvers<void>();
	let childSignal: AbortSignal | undefined;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", { task: "Wait for cancellation" }), {
			stopReason: "toolUse",
		}),
		async (_context, options) => {
			childSignal = options?.signal;
			started.resolve();
			await new Promise((resolve) => childSignal?.addEventListener("abort", resolve, { once: true }));
			return fauxAssistantMessage("obsolete child answer");
		},
		fauxAssistantMessage("other chat answer"),
	]);
	const submission = await agent.submit({ chatGuid: "chat", guid: "parent", text: "Delegate work." });
	await started.promise;
	const record = await submission.status(BACKGROUND_CONTEXT);
	const parent = await agent.harness.conversation(record.conversationId, BACKGROUND_CONTEXT);
	await parent?.abort(BACKGROUND_CONTEXT);
	expect(childSignal?.aborted).toBe(true);
	expect(await submission.wait(BACKGROUND_CONTEXT)).toMatchObject({
		status: "unanswered",
		reason: "aborted",
	});
	await (await agent.submit({ chatGuid: "other", guid: "other", text: "Separate question." })).wait(
		BACKGROUND_CONTEXT,
	);
	await agent.deliver();
	expect(send.mock.calls.map(([, text]) => text)).toEqual(["other chat answer"]);
});
