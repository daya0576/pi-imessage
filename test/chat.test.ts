import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Harness, type Submission } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Chats } from "../src/agent/chats.ts";
import { Deliveries, type SendText } from "../src/agent/deliver.ts";
import * as modelConfig from "../src/agent/models.ts";
import { startService } from "../src/main.ts";

let directory: string;
let agent: Awaited<ReturnType<typeof startService>>;
let faux: FauxProviderHandle;
let options: Required<Parameters<typeof startService>[0]>;
const send = vi.fn<SendText>();
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
	vi.spyOn(console, "warn").mockImplementation(() => {});
	options = {
		workingDir: directory,
		runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
		extensions: [],
		send,
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
	await agent.deliver();
	expect(textCalls()).toEqual(
		expect.arrayContaining([
			["chat-a", "answer"],
			["chat-b", "answer"],
		]),
	);
	expect(send).toHaveBeenCalledTimes(2);
});

it("admits originals while busy and delivers a shared steered answer once", async () => {
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	faux.setResponses([
		async () => {
			started.resolve();
			await gate.promise;
			// An unavailable tool gives a round boundary without enabling any real tools.
			return fauxAssistantMessage(fauxToolCall("not-installed", {}), { stopReason: "toolUse" });
		},
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("second");
			return fauxAssistantMessage("combined");
		},
	]);
	const first = await agent.submit({ chatGuid: "chat", guid: "first-guid", text: "first" });
	await started.promise;
	try {
		const second = await agent.submit({ chatGuid: "chat", guid: "second-guid", text: "second" });
		expect((await second.status(BACKGROUND_CONTEXT)).status).toBe("queued");
		gate.resolve();
		const [left, right] = await Promise.all([answered(first), answered(second)]);
		expect(left.answer).toBe(right.answer);
		await Promise.all([agent.deliver(), agent.deliver()]);
		expect(textCalls()).toEqual([["chat", "combined"]]);
	} finally {
		gate.resolve();
	}
});

it("rejects commands, empty source IDs and disabled chats before model admission", async () => {
	await expect(agent.submit({ chatGuid: "chat", guid: "1", text: "/stop" })).rejects.toThrow("not supported");
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

// #33 Phase 1: exercise the service entry point, not a second agent loop.
it("starts quietly and wires explicit tools, model defaults and working directory", async () => {
	await agent.close();
	await writeFile(join(directory, "fixture.txt"), "isolated tool result");
	const stream = vi.spyOn(options.runtime.models, "streamSimple");
	agent = await startService({ ...options, extensions: [CodingTools] });
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
	expect((await conversation?.agent(BACKGROUND_CONTEXT))?.model).toEqual(options.runtime.defaults.model);
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
