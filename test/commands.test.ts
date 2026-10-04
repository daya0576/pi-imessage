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
import { Chats } from "../src/agent/chats.ts";
import type { SendText } from "../src/agent/deliver.ts";
import { Runs } from "../src/agent/run.ts";
import { startService } from "../src/main.ts";

let directory: string;
let agent: Awaited<ReturnType<typeof startService>>;
let faux: FauxProviderHandle;
const send = vi.fn<SendText>();
const replies = () => send.mock.calls.map(([, text]) => text);

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "imessage-command-"));
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
	);
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	send.mockReset().mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	agent = await startService({
		workingDir: directory,
		agentDir: join(directory, "agent"),
		runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
		extensions: () => [],
		send,
		sendAttachment: vi.fn().mockRejectedValue(new Error("Unexpected attachment send")),
	});
});

afterEach(async () => {
	await agent.close();
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
});

async function chatEntries(chatGuid = "chat") {
	const chat = (await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items.find(
		(item) => item.chatGuid === chatGuid,
	);
	const conversation = chat && (await agent.harness.conversation(chat.conversationId, BACKGROUND_CONTEXT));
	return JSON.stringify(await conversation?.entries({}, 100, undefined, BACKGROUND_CONTEXT));
}

// #33 / ADR 0013: a command row runs once by its GUID, without a model turn or a receipt state machine.
it("runs each command once by source GUID and replies without the model", async () => {
	const thinking = { chatGuid: "chat", guid: "thinking", text: "/thinking high" };
	await agent.command(thinking);
	await agent.command(thinking);
	await agent.command({ chatGuid: "chat", guid: "status", text: "/status" });
	await agent.command({ chatGuid: "chat", guid: "help", text: "/help" });
	await agent.command({ chatGuid: "chat", guid: "stop", text: "/stop" });
	await agent.command({ chatGuid: "chat", guid: "busy-run", text: "/run soon" });
	expect(replies()).toEqual([
		"Thinking: high (this chat only)",
		expect.stringMatching(/thinking: high\nRun: none$/),
		expect.stringContaining("/stop - stop the current /run"),
		"Nothing is running.",
		expect.stringContaining("Usage: /run"),
	]);
	expect(replies()[2]).not.toContain("/run-stop");
	await writeFile(join(directory, "settings.json"), "{}");
	await agent.command({ chatGuid: "disabled", guid: "logged", text: "/new" });
	expect(send).toHaveBeenCalledTimes(5);
	expect(await chatEntries("disabled")).toContain("/new");
	expect(faux.state.callCount).toBe(0);
});

// #33 / ADR 0012: a run works in a fork, takes the chat's messages and delivers every answer as it is written.
it("runs in a fork of the chat, routes ordinary messages to it and records it in the chat", async () => {
	faux.setResponses([fauxAssistantMessage("noted")]);
	await (await agent.submit({ chatGuid: "chat", guid: "context", text: "The trip is in Kyoto." })).wait(
		BACKGROUND_CONTEXT,
	);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	faux.setResponses([
		(context) => {
			const messages = JSON.stringify(context.messages);
			expect(messages).toContain("The trip is in Kyoto.");
			expect(messages).toContain("plan two days");
			return fauxAssistantMessage("day one");
		},
		async (context) => {
			expect(JSON.stringify(context.messages)).toContain("Continue the /run task");
			started.resolve();
			await release.promise;
			return fauxAssistantMessage(fauxToolCall("end_run", { reason: "done" }), { stopReason: "toolUse" });
		},
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("Add a museum.");
			return fauxAssistantMessage("day two with a museum");
		},
		(context) => {
			const messages = JSON.stringify(context.messages);
			expect(messages).toContain("[/run reply, sent]\\nday two with a museum");
			expect(messages).toContain("[/run ended: done]");
			return fauxAssistantMessage("back in the chat");
		},
	]);
	await agent.command({ chatGuid: "chat", guid: "run", text: "/run 30m plan two days" });
	await started.promise;
	// Answers between continuations are delivered while the run goes on.
	await agent.deliver();
	expect(replies()).toEqual(["noted", "day one"]);
	const steer = await agent.submit({ chatGuid: "chat", guid: "museum", text: "Add a museum." });
	expect((await steer.status(BACKGROUND_CONTEXT)).status).toBe("queued");
	release.resolve();
	const run = (await agent.harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items[0];
	if (!run) throw new Error("Missing run");
	await agent.harness.waitForTask(run.taskId, BACKGROUND_CONTEXT);
	await agent.deliver();
	expect(replies()).toEqual(["noted", "day one", "day two with a museum"]);
	expect(await chatEntries()).toContain("Add a museum.");
	await (await agent.submit({ chatGuid: "chat", guid: "after", text: "Anything else?" })).wait(
		BACKGROUND_CONTEXT,
	);
	await agent.deliver();
	expect(replies().at(-1)).toBe("back in the chat");
	expect(faux.state.callCount).toBe(5);
});

// #33 / ADR 0012: /stop ends the run and its queued messages; a busy chat refuses a new run.
it("refuses a run while the chat is busy and stops a run without touching the chat", async () => {
	const chatStarted = Promise.withResolvers<void>();
	const finishChat = Promise.withResolvers<void>();
	const runStarted = Promise.withResolvers<void>();
	faux.setResponses([
		async () => {
			chatStarted.resolve();
			await finishChat.promise;
			return fauxAssistantMessage("chat answer");
		},
		async (_context, options) => {
			runStarted.resolve();
			await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
			return fauxAssistantMessage("obsolete run answer");
		},
	]);
	const ordinary = await agent.submit({ chatGuid: "chat", guid: "work", text: "Ordinary work." });
	await chatStarted.promise;
	await agent.command({ chatGuid: "chat", guid: "early-run", text: "/run 10m" });
	finishChat.resolve();
	await ordinary.wait(BACKGROUND_CONTEXT);
	await agent.command({ chatGuid: "chat", guid: "run", text: "/run 10m keep going" });
	await runStarted.promise;
	const queued = await agent.submit({ chatGuid: "chat", guid: "queued", text: "Queued in the run." });
	await agent.command({ chatGuid: "chat", guid: "stop", text: "/stop" });
	expect(await queued.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "unanswered", reason: "aborted" });
	await agent.deliver();
	expect(replies()).toEqual([expect.stringContaining("Busy."), "Stopped.", "chat answer"]);
	expect(await chatEntries()).toContain("[/run ended: stopped]");
	expect((await agent.harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items[0]?.status).toBe("ended");
	await agent.command({ chatGuid: "chat", guid: "stop-again", text: "/stop" });
	expect(replies().at(-1)).toBe("Nothing is running.");
	expect(faux.state.callCount).toBe(2);
});
