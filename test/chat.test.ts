import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type TranscriptContext, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, Harness, type Submission, UserEntry } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Chats } from "../src/agent/chats.ts";
import type { SendText } from "../src/agent/deliver.ts";
import { DirectSends } from "../src/agent/direct-send.ts";
import * as modelConfig from "../src/agent/models.ts";
import { Deliveries } from "../src/agent/replies.ts";
import { startService } from "../src/main.ts";
import type { MessageSender } from "../src/transport/send.ts";

let directory: string;
let agent: Awaited<ReturnType<typeof startService>>;
let faux: FauxProviderHandle;
let options: Required<Parameters<typeof startService>[0]>;
const send = vi.fn<SendText>();
const sendAttachment = vi.fn<MessageSender["sendAttachment"]>();
const textCalls = () => send.mock.calls.map(([chatGuid, text]) => [chatGuid, text]);

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "imessage-chat-"));
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			chatAllowlist: { whitelist: ["*"], blacklist: [] },
		}),
	);
	faux = fauxProvider();
	const models = createModels(); // In-memory credentials; no installed providers or auth files.
	models.setProvider(faux.provider);
	const model = faux.getModel();
	send.mockReset().mockResolvedValue(undefined);
	sendAttachment.mockReset().mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	options = {
		workingDir: directory,
		agentDir: join(directory, "agent"),
		runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
		extensions: () => [],
		send,
		sendAttachment,
	};
	agent = await startService(options);
});

afterEach(async () => {
	await agent.close();
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
});

async function answered(submission: Submission) {
	const record = await submission.wait(BACKGROUND_CONTEXT);
	expect(record.status).toBe("done");
	if (record.status !== "done" || record.type !== "input") throw new Error("Expected a final answer");
	return record;
}

it("maps chats separately, passes source GUIDs, and sends only final text", async () => {
	const requests: TranscriptContext[] = [];
	const reply = (context: TranscriptContext) => {
		requests.push(context);
		return fauxAssistantMessage([
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "planning", textSignature: JSON.stringify({ v: 1, phase: "commentary" }) },
			{ type: "text", text: "answer", textSignature: JSON.stringify({ v: 1, phase: "final" }) },
		]);
	};
	faux.setResponses([reply, reply]);
	const [first, second] = await Promise.all([
		agent.submit({ chatGuid: "chat-a", guid: "source-1", text: "alpha" }),
		agent.submit({ chatGuid: "chat-b", guid: "source-1", text: "beta" }),
	]);
	const records = await Promise.all([answered(first), answered(second)]);
	expect(records.map((record) => record.requestId)).toEqual(["source-1", "source-1"]);
	expect(records[0].conversationId).not.toBe(records[1].conversationId);
	expect(
		requests.map((request) => request.messages.filter((message) => message.role === "user").length),
	).toEqual([1, 1]);
	for (const request of requests) {
		for (const message of request.messages) {
			if (message.role === "system") expect(message.toolsAdded ?? []).toHaveLength(0);
		}
	}
	// #33 / ADR 0011: a passive user entry is not an intervening ordinary input.
	const conversation = await agent.harness.conversation(records[0].conversationId, BACKGROUND_CONTEXT);
	if (!conversation) throw new Error("Missing conversation");
	await (
		await conversation.submit(
			{
				type: "write",
				entry: {
					kind: UserEntry.kind,
					model: [{ role: "user", content: "Passive host note.", timestamp: Date.now() }],
				},
			},
			BACKGROUND_CONTEXT,
		)
	).wait(BACKGROUND_CONTEXT);
	await agent.deliver();
	expect(textCalls()).toEqual(
		expect.arrayContaining([
			["chat-a", "answer"],
			["chat-b", "answer"],
		]),
	);
	expect(send).toHaveBeenCalledTimes(2);
});

// #33 Phase 2: configure native all-at-once steer and pass guidance without a host batch/replay loop.
it("admits all busy-chat additions at the next tool boundary without repeating completed work", async () => {
	await agent.close();
	const lookup = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "Lookup completed: museum is open." }],
	}));
	const tools = defineExtension({
		name: "fixture",
		tools: [
			defineTool({
				name: "lookup",
				description: "Read a fixture fact",
				parameters: Type.Object({}),
				replay: "safe",
				execute: lookup,
			}),
		],
	});
	agent = await startService({ ...options, extensions: () => [tools] });
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const additions = [
		"Include a museum.",
		"Correction: three days instead of two.",
		"Separately, what is 2 + 2?",
		"What is finished so far?",
	];
	const reply = "Three-day plan with a museum. Separate answer: 4. Progress: lookup complete.";
	faux.setResponses([
		async () => {
			started.resolve();
			await gate.promise;
			return fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "toolUse" });
		},
		(context) => {
			const messages = JSON.stringify(context.messages);
			for (const text of additions) expect(messages).toContain(text);
			expect(messages).toContain("Lookup completed: museum is open.");
			const sections = context.messages
				.filter((message) => message.role === "system")
				.flatMap((message) => message.sections?.["chat-steer"] ?? []);
			expect(sections).toHaveLength(1);
			expect(sections[0]).toContain("newest explicit correction");
			expect(sections[0]).toContain("Keep unrelated questions separate");
			expect(sections[0]).toContain("Do not restart the task");
			// A scripted answer verifies our wiring, not a real model's semantic judgment.
			return fauxAssistantMessage(reply);
		},
	]);
	const first = await agent.submit({
		chatGuid: "chat",
		guid: "first-guid",
		text: "Plan a trip for two days.",
	});
	await started.promise;
	try {
		const pending = [];
		for (const [index, text] of additions.entries()) {
			const submission = await agent.submit({ chatGuid: "chat", guid: `addition-${index}`, text });
			expect((await submission.status(BACKGROUND_CONTEXT)).status).toBe("queued");
			pending.push(submission);
		}
		gate.resolve();
		const records = await Promise.all([first, ...pending].map(answered));
		expect(new Set(records.map((record) => record.answer)).size).toBe(1);
		await Promise.all([agent.deliver(), agent.deliver()]);
		expect(textCalls()).toEqual([["chat", reply]]);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(faux.state.callCount).toBe(2);
	} finally {
		gate.resolve();
	}
});

// #33 Phase 2: ordinary chat policy must not leak into isolated service conversations.
it("omits chat steering guidance from an unmapped isolated conversation", async () => {
	faux.setResponses([
		(context) => {
			expect(JSON.stringify(context.messages)).not.toContain("chat-steer");
			expect(JSON.stringify(context.messages)).not.toContain("reply-delivery");
			return fauxAssistantMessage("isolated answer");
		},
	]);
	const conversation = await agent.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: options.runtime.defaults,
		},
		BACKGROUND_CONTEXT,
	);
	await answered(
		await conversation.submit(
			{ type: "input", content: "Summarize an isolated result." },
			BACKGROUND_CONTEXT,
		),
	);
	await agent.deliver();
	expect(send).not.toHaveBeenCalled();
	expect(await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT)).toBeUndefined();
});

// #33 / ADR 0011: late input from another sender holds an unattempted draft until reconciliation.
it("reconciles unsent answers with multiple senders and preserves the replaced draft", async () => {
	const firstStarted = Promise.withResolvers<void>();
	const finishFirst = Promise.withResolvers<void>();
	const nextStarted = Promise.withResolvers<void>();
	const finishNext = Promise.withResolvers<void>();
	const oldText = "Alex: a two-day plan.";
	const newText = "Alex: corrected four-day plan. Blair: separate three-day plan.";
	faux.setResponses([
		async () => {
			firstStarted.resolve();
			await finishFirst.promise;
			return fauxAssistantMessage(oldText);
		},
		async (context) => {
			const messages = JSON.stringify(context.messages);
			expect(messages).toContain("from Alex]");
			expect(messages).toContain("from Blair]");
			expect(messages).toContain("Do not assume one person's message retracts another person's requirements");
			const facts = context.messages
				.filter((message) => message.role === "system")
				.flatMap((message) => message.sections?.["reply-delivery"] ?? [])
				.at(-1);
			expect(facts).toContain(oldText);
			expect(facts).toContain('"status":"unattempted"');
			nextStarted.resolve();
			await finishNext.promise;
			return fauxAssistantMessage(newText);
		},
	]);
	const source = {
		chatGuid: "iMessage;+;shared",
		groupName: "Shared",
		sender: "Alex",
		guid: "alex-1",
		text: "My plan is two days.",
	};
	const first = await agent.submit(source);
	await firstStarted.promise;
	try {
		const second = await agent.submit({
			...source,
			guid: "blair-1",
			sender: "Blair",
			text: "My separate plan is three days. Keep Alex's request too.",
		});
		const third = await agent.submit({
			...source,
			guid: "alex-2",
			text: "Correction: my own trip is four days.",
		});
		finishFirst.resolve();
		const original = await answered(first);
		await nextStarted.promise;
		await agent.deliver();
		expect(send).not.toHaveBeenCalled();
		expect(
			(await agent.harness.snapshot(Deliveries, original.conversationId, BACKGROUND_CONTEXT))?.drafts?.[
				String(original.answer)
			],
		).toEqual({ status: "held", reason: "newer_input" });
		finishNext.resolve();
		const [replacement, shared] = await Promise.all([answered(second), answered(third)]);
		expect(replacement.answer).toBe(shared.answer);
		await Promise.all([agent.deliver(), agent.deliver()]);
		expect(textCalls()).toEqual([[source.chatGuid, newText]]);
		const receipts = await agent.harness.snapshot(Deliveries, original.conversationId, BACKGROUND_CONTEXT);
		expect(receipts?.drafts?.[String(original.answer)]).toEqual({
			status: "superseded",
			replacement: replacement.answer,
		});
		expect(receipts?.answers[String(original.answer)]).toBeUndefined();
		expect(receipts?.answers[String(replacement.answer)]).toBe("sent");
		const conversation = await agent.harness.conversation(original.conversationId, BACKGROUND_CONTEXT);
		expect(JSON.stringify(await conversation?.entries({}, 100, undefined, BACKGROUND_CONTEXT))).toContain(
			oldText,
		);
		expect(faux.state.callCount).toBe(2);
	} finally {
		finishFirst.resolve();
		finishNext.resolve();
	}
});

// #33 / ADR 0011: reconciliation failure is not permission to release the obsolete draft.
it("retains a held draft after reconciliation fails and the service reopens", async () => {
	faux.setResponses([fauxAssistantMessage("obsolete draft")]);
	const first = await answered(await agent.submit({ chatGuid: "chat", guid: "old", text: "Old condition." }));
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	faux.setResponses([
		async () => {
			started.resolve();
			await finish.promise;
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid input" });
		},
	]);
	const second = await agent.submit({
		chatGuid: "chat",
		guid: "correction",
		text: "Use the corrected condition.",
	});
	await started.promise;
	try {
		await agent.deliver();
		expect(send).not.toHaveBeenCalled();
		finish.resolve();
		expect(await second.wait(BACKGROUND_CONTEXT)).toMatchObject({ status: "unanswered" });
		await agent.close();
		agent = await startService(options);
		await agent.deliver();
		expect(send).not.toHaveBeenCalled();
		expect(
			(await agent.harness.snapshot(Deliveries, first.conversationId, BACKGROUND_CONTEXT))?.drafts?.[
				String(first.answer)
			],
		).toEqual({ status: "held", reason: "newer_input" });
	} finally {
		finish.resolve();
	}
});

// #33 / ADR 0011: input after a transport claim cannot retract that send or overtake it.
it("keeps an already claimed reply and sends the subsequent answer only after it settles", async () => {
	faux.setResponses([fauxAssistantMessage("claimed answer"), fauxAssistantMessage("new answer")]);
	await answered(await agent.submit({ chatGuid: "chat", guid: "first", text: "Original." }));
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	send.mockImplementationOnce(async () => {
		started.resolve();
		await finish.promise;
	});
	const sending = agent.deliver();
	await started.promise;
	try {
		await answered(await agent.submit({ chatGuid: "chat", guid: "later", text: "Later request." }));
		await agent.deliver();
		expect(send).toHaveBeenCalledTimes(1);
		finish.resolve();
		await sending;
		await agent.deliver();
		expect(textCalls()).toEqual([
			["chat", "claimed answer"],
			["chat", "new answer"],
		]);
	} finally {
		finish.resolve();
		await sending;
	}
});

it("rejects commands, empty source IDs and disabled chats before model admission", async () => {
	await expect(agent.submit({ chatGuid: "chat", guid: "1", text: "/stop" })).rejects.toThrow("command()");
	await expect(agent.submit({ chatGuid: "chat", guid: "", text: "hello" })).rejects.toThrow("required");
	await writeFile(join(directory, "settings.json"), "{}");
	await expect(agent.submit({ chatGuid: "chat", guid: "2", text: "hello" })).rejects.toThrow("disabled");
	expect(await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT)).toBeUndefined();
	const disabled = { chatGuid: "chat", guid: "logged", text: "/stop" };
	const logged = await agent.submit(disabled, { logDisabled: true });
	expect(await logged.wait(BACKGROUND_CONTEXT)).toMatchObject({ type: "write", status: "done" });
	expect((await agent.submit(disabled, { logDisabled: true })).id).toBe(logged.id);
	expect(faux.state.callCount).toBe(0);
	expect(send).not.toHaveBeenCalled();
});

it("recovers an unsent saved answer, then preserves its sent receipt across reopen", async () => {
	faux.setResponses([fauxAssistantMessage("saved")]);
	const input = { chatGuid: "chat", guid: "original", text: "hello" };
	const first = await agent.submit(input);
	await answered(first);
	await agent.close();
	agent = await startService(options);
	const duplicate = await agent.submit(input);
	expect(duplicate.id).toBe(first.id);
	await agent.deliver();
	expect(textCalls()).toEqual([["chat", "saved"]]);
	await agent.close();
	agent = await startService(options);
	await agent.deliver();
	expect(send).toHaveBeenCalledTimes(1);
	expect(faux.state.callCount).toBe(1);
});

it("marks an unfinished send unknown on reopen without sending it", async () => {
	faux.setResponses([fauxAssistantMessage("uncertain")]);
	const record = await answered(await agent.submit({ chatGuid: "chat", guid: "1", text: "hello" }));
	// Seed our own pre-send state; do not retest Durable's crash machinery.
	await agent.harness.commit(async (tx) => {
		(await tx.doc(Deliveries, record.conversationId)).answers[String(record.answer)] = "sending";
	}, BACKGROUND_CONTEXT);
	await agent.close();
	agent = await startService(options);
	await agent.deliver();
	const deliveries = await agent.harness.snapshot(Deliveries, record.conversationId, BACKGROUND_CONTEXT);
	expect(deliveries?.answers[String(record.answer)]).toBe("unknown");
	expect(console.warn).toHaveBeenCalledWith(
		"Reply delivery unknown",
		record.conversationId,
		String(record.answer),
	);
	expect(send).not.toHaveBeenCalled();
	expect(faux.state.callCount).toBe(1);
});

// #33 Phase 2: use current rich-text settings, without retrying a possibly completed rich send.
it("passes live rich-text settings and does not retry a sender that throws after a possible effect", async () => {
	faux.setResponses([fauxAssistantMessage("uncertain")]);
	const record = await answered(await agent.submit({ chatGuid: "chat", guid: "1", text: "hello" }));
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			chatAllowlist: { whitelist: ["*"], blacklist: [] },
			richText: { enabled: true, markdown: false },
		}),
	);
	send.mockRejectedValue(new Error("transport failed after effect"));
	await agent.deliver();
	expect(send).toHaveBeenCalledWith("chat", "uncertain", { enabled: true, markdown: false });
	await agent.close();
	agent = await startService(options);
	await agent.deliver();
	expect(send).toHaveBeenCalledTimes(1);
	expect(
		(await agent.harness.snapshot(Deliveries, record.conversationId, BACKGROUND_CONTEXT))?.answers[
			String(record.answer)
		],
	).toBe("unknown");
});

it("checks the allowlist again before delivery", async () => {
	faux.setResponses([fauxAssistantMessage("saved")]);
	await answered(await agent.submit({ chatGuid: "chat", guid: "1", text: "hello" }));
	await writeFile(join(directory, "settings.json"), "{}");
	await agent.deliver();
	expect(send).not.toHaveBeenCalled();
});

it("holds the storage lock and joins an in-flight send before closing", async () => {
	await expect(startService(options)).rejects.toMatchObject({ code: "EEXIST" });
	faux.setResponses([fauxAssistantMessage("saved")]);
	await answered(await agent.submit({ chatGuid: "chat", guid: "1", text: "hello" }));
	const gate = Promise.withResolvers<void>();
	const sending = Promise.withResolvers<void>();
	send.mockImplementation(async () => {
		sending.resolve();
		await gate.promise;
	});
	const delivery = agent.deliver();
	await sending.promise;
	try {
		const closing = agent.close();
		expect(agent.close()).toBe(closing);
		await expect(agent.deliver()).rejects.toThrow("closed");
		await expect(agent.submit({ chatGuid: "chat", guid: "2", text: "later" })).rejects.toThrow("closed");
		await expect(startService(options)).rejects.toMatchObject({ code: "EEXIST" });
		gate.resolve();
		await Promise.all([delivery, closing]);
		agent = await startService(options);
		await agent.deliver();
		expect(send).toHaveBeenCalledTimes(1);
	} finally {
		gate.resolve();
	}
});

// #33 Phase 2: direct sends report each effect and reuse receipts, without an agent turn or retry queue.
it("records direct text/file outcomes, rejects conflicting IDs and stops after uncertain text", async () => {
	await writeFile(join(directory, "settings.json"), "{}"); // Explicit sends are not automatic replies.
	const input = { chatGuid: "chat", requestId: "send-1", text: "report", filePath: "/fake/report.pdf" };
	const sent = await agent.sendDirect(input);
	expect(sent).toMatchObject({ textStatus: "sent", fileStatus: "sent" });
	expect(await agent.sendDirect(input)).toEqual(sent);
	await expect(agent.sendDirect({ ...input, text: "changed" })).rejects.toThrow("different content");
	await expect(agent.sendDirect({ chatGuid: "chat", requestId: "empty" })).rejects.toThrow("required");
	expect(send.mock.calls).toEqual([["chat", "report"]]);
	expect(sendAttachment.mock.calls).toEqual([["chat", "/fake/report.pdf"]]);
	await agent.sendDirect({ chatGuid: "other", requestId: input.requestId, filePath: "/fake/other.pdf" });
	expect(sendAttachment).toHaveBeenCalledTimes(2);
	send.mockRejectedValueOnce(new Error("text might already be sent"));
	const uncertain = { ...input, requestId: "send-2" };
	expect(await agent.sendDirect(uncertain)).toMatchObject({
		textStatus: "unknown",
		fileStatus: "not_attempted",
	});
	expect(await agent.sendDirect(uncertain)).toMatchObject({
		textStatus: "unknown",
		fileStatus: "not_attempted",
	});
	expect(send).toHaveBeenCalledTimes(2);
	expect(sendAttachment).toHaveBeenCalledTimes(2);
	expect(faux.state.callCount).toBe(0);
	expect(await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT)).toBeUndefined();
});

// #33 Phase 2: a partial direct send must not repeat successful or uncertain parts after close/reopen.
it("joins a partial direct send and preserves per-part receipts across restart", async () => {
	const sending = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	sendAttachment.mockImplementation(async () => {
		sending.resolve();
		await gate.promise;
		throw new Error("attachment result unknown");
	});
	const input = { chatGuid: "chat", requestId: "partial", text: "report", filePath: "/fake/report.pdf" };
	const delivery = agent.sendDirect({ ...input });
	await sending.promise;
	try {
		expect(await agent.sendDirect(input)).toMatchObject({ textStatus: "sent", fileStatus: "sending" });
		const closing = agent.close();
		await expect(agent.sendDirect(input)).rejects.toThrow("closed");
		await expect(startService(options)).rejects.toMatchObject({ code: "EEXIST" });
		gate.resolve();
		expect(await delivery).toMatchObject({ textStatus: "sent", fileStatus: "unknown" });
		await closing;
		agent = await startService(options);
		expect(await agent.sendDirect(input)).toMatchObject({ textStatus: "sent", fileStatus: "unknown" });
		// Seed only our receipt state, not a Durable subprocess/crash simulation.
		await agent.harness.commit(async (tx) => {
			(await tx.doc(DirectSends)).requests.push({
				...input,
				requestId: "interrupted",
				textStatus: "sent",
				fileStatus: "sending",
			});
		}, BACKGROUND_CONTEXT);
		await agent.close();
		agent = await startService(options);
		expect(await agent.sendDirect({ ...input, requestId: "interrupted" })).toMatchObject({
			textStatus: "sent",
			fileStatus: "unknown",
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(sendAttachment).toHaveBeenCalledTimes(1);
		expect(faux.state.callCount).toBe(0);
	} finally {
		gate.resolve();
	}
});

// #33 Phase 1: exercise the service entry point, not a second agent loop.
it("starts quietly and wires default coding/image tools, model defaults and working directory", async () => {
	await agent.close();
	await writeFile(join(directory, "fixture.txt"), "isolated tool result");
	const stream = vi.spyOn(options.runtime.models, "streamSimple");
	agent = await startService({ ...options, extensions: undefined });
	expect(stream).not.toHaveBeenCalled();
	expect(send).not.toHaveBeenCalled();
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }),
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("isolated tool result");
			return fauxAssistantMessage("read complete");
		},
	]);
	const input = {
		chatGuid: "chat",
		guid: "tool-input",
		text: "Read the file.",
		attachments: ["original.txt"],
	};
	const submission = agent.submit(input);
	input.attachments[0] = "mutated.txt";
	const record = await answered(await submission);
	const conversation = await agent.harness.conversation(record.conversationId, BACKGROUND_CONTEXT);
	const resolved = await conversation?.agent(BACKGROUND_CONTEXT);
	expect(resolved?.model).toEqual(options.runtime.defaults.model);
	expect(resolved?.tools.map((tool) => tool.name).sort()).toEqual([
		"bash",
		"edit",
		"load_memory",
		"read",
		"save_memory",
		"search_memory",
		"write",
	]);
	expect(resolved?.tools.find((tool) => tool.name === "read")?.description).toContain(
		"Images are kept as file references",
	);
	expect(stream.mock.calls[0][2]?.transport).toBe("sse");
	expect(JSON.stringify(stream.mock.calls[0][1])).toContain("original.txt");
	expect(JSON.stringify(stream.mock.calls[0][1])).not.toContain("mutated.txt");
	await agent.deliver();
	expect(textCalls()).toEqual([["chat", "read complete"]]);
});

// #33 Phase 1: failed startup must not strand the host's storage lock.
it("rejects unavailable models and releases ownership after a failed harness open", async () => {
	await agent.close();
	const models = vi.spyOn(modelConfig, "openModels").mockRejectedValueOnce(new Error("auth unavailable"));
	await expect(startService({ ...options, runtime: undefined })).rejects.toThrow("auth unavailable");
	models.mockRestore();
	await expect(
		startService({
			...options,
			runtime: { ...options.runtime, defaults: { model: { provider: "missing", modelId: "missing" } } },
		}),
	).rejects.toThrow("Model is unavailable");
	const open = vi.spyOn(Harness, "open").mockRejectedValueOnce(new Error("startup failed"));
	await expect(startService(options)).rejects.toThrow("startup failed");
	open.mockRestore();
	await expect(access(join(directory, "durable", "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
	agent = await startService(options);
	expect(faux.state.callCount).toBe(0);
	expect(send).not.toHaveBeenCalled();
});

// #33 Phase 1: shutting down must cancel active model work before releasing ownership.
it("closes during model execution without waiting for a final answer or sending one", async () => {
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	faux.setResponses([
		async (_context, streamOptions) => {
			signal = streamOptions?.signal;
			signal?.addEventListener("abort", () => gate.resolve(), { once: true });
			started.resolve();
			await gate.promise;
			return fauxAssistantMessage("late answer");
		},
	]);
	await agent.submit({ chatGuid: "chat", guid: "in-flight", text: "hello" });
	await started.promise;
	try {
		await agent.close();
		expect(signal?.aborted).toBe(true);
		await expect(access(join(directory, "durable", "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(send).not.toHaveBeenCalled();
	} finally {
		gate.resolve();
	}
});
