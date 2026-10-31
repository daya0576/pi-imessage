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
import { AssistantEntry } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Chats, IDLE_RESET_AFTER_MS, IDLE_RESET_MIN_TOKENS } from "../src/agent/chats.ts";
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

// #33: a command row runs once by its GUID, without a model turn or a receipt state machine.
it("runs each command once by source GUID and replies without the model", async () => {
	const thinking = { chatGuid: "chat", guid: "thinking", text: "/thinking high" };
	await agent.command(thinking);
	await agent.command(thinking);
	await agent.command({ chatGuid: "chat", guid: "status", text: "/status" });
	await agent.command({ chatGuid: "chat", guid: "help", text: "/help" });
	await agent.command({ chatGuid: "chat", guid: "stop", text: "/stop" });
	await agent.command({ chatGuid: "chat", guid: "busy-run", text: "/run soon" });
	// /verbose reads the chat override before the global setting and validates its argument.
	// /interim is the same per-chat switch and defaults to on.
	for (const text of [
		"/verbose",
		"/verbose on",
		"/verbose default",
		"/verbose loud",
		"/interim off",
		"/interim",
	])
		await agent.command({ chatGuid: "chat", guid: text, text });
	const reset = { chatGuid: "chat", guid: "reset", text: "/new" };
	await agent.command(reset);
	await agent.command(reset);
	await agent.command({ chatGuid: "chat", guid: "reload", text: "/reload" });
	expect(replies()).toEqual([
		"Thinking: high (this chat only)",
		expect.stringMatching(/ · high$/), // No run line while nothing runs.
		expect.stringContaining("/stop - stop the current work or /run"),
		"Nothing is running.",
		expect.stringContaining("Usage: /run"),
		"Verbose: off (default)",
		"Verbose: on (this chat only)",
		"Verbose: off (default)",
		"Usage: /verbose [on|off|default]",
		"Interim: off (this chat only)",
		"Interim: off (this chat only)",
		"0 msgs · ~0.0% / 128k\nfaux/faux-1 · high", // Estimated: nothing was sent to the model yet.
		"0 msgs · ~0.0% / 128k\nfaux/faux-1 · high", // /reload replies like /status.
	]);
	expect(replies()[2]).toContain("/verbose [on|off|default]");
	expect(replies()[2]).not.toContain("/run-stop");
	await writeFile(join(directory, "settings.json"), "{}");
	await agent.command({ chatGuid: "disabled", guid: "logged", text: "/new" });
	expect(send).toHaveBeenCalledTimes(13);
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
	await agent.command({ chatGuid: "chat", guid: "status-running", text: "/status" });
	expect(replies().at(-1)).toMatch(/\nrun · until \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
	const steer = await agent.submit({ chatGuid: "chat", guid: "museum", text: "Add a museum." });
	expect((await steer.status(BACKGROUND_CONTEXT)).status).toBe("queued");
	release.resolve();
	const run = (await agent.harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items[0];
	if (!run) throw new Error("Missing run");
	await agent.harness.waitForTask(run.taskId, BACKGROUND_CONTEXT);
	await agent.deliver();
	expect(replies().slice(-1)).toEqual(["day two with a museum"]);
	expect(await chatEntries()).toContain("Add a museum.");
	await (await agent.submit({ chatGuid: "chat", guid: "after", text: "Anything else?" })).wait(
		BACKGROUND_CONTEXT,
	);
	await agent.deliver();
	expect(replies().at(-1)).toBe("back in the chat");
	expect(faux.state.callCount).toBe(5);

	await agent.command({ chatGuid: "chat", guid: "before-reset", text: "/status" });
	const before = replies().at(-1);
	expect(before).toMatch(/^\d+ msgs · \d+\.\d+% \/ 128k\n/);
	await agent.command({ chatGuid: "chat", guid: "reset", text: "/new" });
	// Before the first reply the usage is estimated from the retained system prompt and tools, hence not zero.
	expect(replies().at(-1)).toMatch(/^0 msgs · ~\d+\.\d+% \/ 128k\n/);
	expect(replies().at(-1)).not.toContain("~0.0%");
	expect(replies().at(-1)?.split("\n")[1]).toBe(before?.split("\n")[1]);
	await agent.command({ chatGuid: "chat", guid: "after-reset", text: "/status" });
	expect(replies().at(-1)).toBe(replies().at(-2)); // Same report; the run line exists only during a run.
	expect(faux.state.callCount).toBe(5);

	// A context over the token floor whose last turn is older than the idle limit starts fresh on the
	// next message; a fresh one of the same size, or an old small one, is kept.
	const chat = (await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items.find(
		(item) => item.chatGuid === "chat",
	);
	const conversation = chat && (await agent.harness.conversation(chat.conversationId, BACKGROUND_CONTEXT));
	if (!conversation) throw new Error("Missing chat conversation");
	const lastTurn = async (totalTokens: number, age: number) => {
		const message = fauxAssistantMessage(`turn of ${totalTokens} tokens`, { timestamp: Date.now() - age });
		await (
			await conversation.submit(
				{
					type: "write",
					entry: {
						kind: AssistantEntry.kind,
						model: [{ ...message, usage: { ...message.usage, totalTokens } }],
					},
				},
				BACKGROUND_CONTEXT,
			)
		).wait(BACKGROUND_CONTEXT);
	};
	const seen: string[] = [];
	faux.setResponses([
		(context) => {
			seen.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("kept");
		},
		(context) => {
			seen.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("fresh start");
		},
	]);
	await lastTurn(IDLE_RESET_MIN_TOKENS + 1, 1000);
	await lastTurn(IDLE_RESET_MIN_TOKENS, IDLE_RESET_AFTER_MS + 1000);
	await (await agent.submit({ chatGuid: "chat", guid: "soon", text: "Still here." })).wait(
		BACKGROUND_CONTEXT,
	);
	expect(seen[0]).toContain(`turn of ${IDLE_RESET_MIN_TOKENS} tokens`);
	await agent.deliver();
	expect(replies().at(-1)).toBe("kept");
	await lastTurn(IDLE_RESET_MIN_TOKENS + 1, IDLE_RESET_AFTER_MS + 1000);
	await (await agent.submit({ chatGuid: "chat", guid: "much-later", text: "New topic." })).wait(
		BACKGROUND_CONTEXT,
	);
	expect(seen[1]).not.toContain("Still here.");
	expect(seen[1]).not.toContain("turn of");
	expect(seen[1]).toContain("New topic.");
	await agent.deliver();
	expect(replies().at(-1)).toBe("fresh start");
	expect(faux.state.callCount).toBe(7);
});

// #33 / ADR 0012: /stop ends a run with its queued messages, or ordinary work keeping later messages.
it("refuses a run while the chat is busy and stops runs and ordinary work", async () => {
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

	const workStarted = Promise.withResolvers<void>();
	faux.setResponses([
		async (_context, options) => {
			workStarted.resolve();
			await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
			return fauxAssistantMessage("obsolete answer");
		},
		() => fauxAssistantMessage("later answer"),
	]);
	const slow = await agent.submit({ chatGuid: "chat", guid: "slow", text: "Slow work." });
	await workStarted.promise;
	const later = await agent.submit({ chatGuid: "chat", guid: "later", text: "Later message." });
	await agent.command({ chatGuid: "chat", guid: "stop-work", text: "/stop" });
	expect(await slow.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "unanswered", reason: "aborted" });
	expect(await later.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "done" });
	await agent.deliver();
	expect(replies().slice(-2)).toEqual(["Stopped.", "later answer"]);
});
