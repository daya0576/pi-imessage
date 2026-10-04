import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
let memoryRoot: string;
let agent: Awaited<ReturnType<typeof startService>> | undefined;
let options: Parameters<typeof startService>[0];
let faux: FauxProviderHandle;
const responses = {
	"list-namespaces": [{ namespace: "fixture/one", active: 1 }],
	load: [{ id: "old", text: "Fixture memory", sources: [{ type: "chat", label: "fixture" }] }],
	search: [{ id: "old", text: "Fixture memory" }],
	add: { added: true, item: { id: "new", supersedes_id: "old" } },
};

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "imessage-memory-"));
	memoryRoot = join(directory, "skills", "file-memory");
	await mkdir(memoryRoot, { recursive: true });
	await copyFile(new URL("./fixtures/memory-cli.py", import.meta.url), join(memoryRoot, "memory_cli.py"));
	await writeFile(join(memoryRoot, "responses.json"), JSON.stringify(responses));
	await writeFile(join(memoryRoot, "core.md"), "Core fixture v1.");
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
	);
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	options = {
		workingDir: directory,
		agentDir: join(directory, "agent"),
		runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
		send: vi.fn().mockResolvedValue(undefined),
		sendAttachment: vi.fn().mockRejectedValue(new Error("Unexpected attachment send")),
	};
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	await agent?.close();
	agent = undefined;
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
});

// #33 / ADR 0013: tools delegate arguments and results to the existing CLI; no host memory backend.
it("offers memory tools by default, forwards their CLI arguments and refreshes core/namespaces on reload", async () => {
	agent = await startService(options);
	const fact = "--quoted 'fact'; $(touch forbidden)\n第二行";
	faux.setResponses([
		(context) => {
			const memory = context.messages.filter((message) => message.role === "system").at(-1)?.sections?.memory;
			expect(memory).toContain("Core fixture v1.");
			expect(memory).toContain("fixture/one");
			return fauxAssistantMessage(
				fauxToolCall("save_memory", {
					text: fact,
					namespace: "fixture/one",
					kind: "fact",
					subjects: ["Henry", "CC"],
					event_time: "2026-10-04",
					source: "--source with spaces",
					importance: 0.6,
					confidence: 0.8,
					supersedes_id: "old",
				}),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			expect(JSON.stringify(context.messages)).toContain('\\"supersedes_id\\": \\"old\\"');
			return fauxAssistantMessage(
				fauxToolCall("load_memory", { namespaces: ["fixture/one", "fixture/two"] }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			expect(JSON.stringify(context.messages)).toContain("Fixture memory");
			return fauxAssistantMessage(
				fauxToolCall("search_memory", {
					query: "--literal query",
					namespaces: ["fixture/one", "fixture/two"],
					limit: 7,
				}),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("Memory tools completed."),
	]);
	const settled = await (
		await agent.submit({ chatGuid: "chat", guid: "memory", text: "Remember this fixture." })
	).wait(BACKGROUND_CONTEXT);
	expect(settled.status).toBe("done");
	const calls = (await readFile(join(memoryRoot, "calls.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(calls).toEqual([
		["list-namespaces"],
		[
			"add",
			`--text=${fact}`,
			"--namespace=fixture/one",
			"--kind=fact",
			"--subjects",
			"Henry",
			"CC",
			"--event-time=2026-10-04",
			"--source=--source with spaces",
			"--importance=0.6",
			"--confidence=0.8",
			"--supersedes=old",
		],
		["load", "--namespace=fixture/one", "--namespace=fixture/two"],
		["search", "--limit", "7", "--namespace=fixture/one", "--namespace=fixture/two", "--", "--literal query"],
	]);
	await expect(access(join(directory, "forbidden"))).rejects.toThrow();
	await writeFile(join(memoryRoot, "core.md"), "Core fixture v2.");
	await writeFile(
		join(memoryRoot, "responses.json"),
		JSON.stringify({ ...responses, "list-namespaces": [{ namespace: "fixture/two", active: 1 }] }),
	);
	await agent.command({ chatGuid: "chat", guid: "reload", text: "/reload" });
	faux.setResponses([
		(context) => {
			const memory = context.messages
				.filter((message) => message.role === "system")
				.findLast((message) => message.sections?.memory)?.sections?.memory;
			expect(memory).toContain("Core fixture v2.");
			expect(memory).toContain("fixture/two");
			expect(memory).not.toContain("fixture/one");
			return fauxAssistantMessage("Refreshed.");
		},
	]);
	expect(
		(
			await (
				await agent.submit({ chatGuid: "chat", guid: "refreshed", text: "Use refreshed memory." })
			).wait(BACKGROUND_CONTEXT)
		).status,
	).toBe("done");
	expect(faux.state.callCount).toBe(5);
});

// #33: an unavailable or failing writer is a tool error, and cancellation reaches its subprocess.
it("surfaces missing/failed CLI calls without retrying and terminates a cancelled CLI process", async () => {
	await rm(join(memoryRoot, "memory_cli.py"));
	agent = await startService(options);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("load_memory", { namespaces: ["fixture/one"] }), {
			stopReason: "toolUse",
		}),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("memory_cli.py");
			return fauxAssistantMessage("Memory unavailable.");
		},
	]);
	await (await agent.submit({ chatGuid: "chat", guid: "missing", text: "Load memory." })).wait(
		BACKGROUND_CONTEXT,
	);
	await copyFile(new URL("./fixtures/memory-cli.py", import.meta.url), join(memoryRoot, "memory_cli.py"));
	await writeFile(join(memoryRoot, "responses.json"), JSON.stringify({ ...responses, reject_write: true }));
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("save_memory", {
				text: "Rejected fact",
				namespace: "fixture/one",
				kind: "fact",
				subjects: [],
				event_time: null,
				source: "fixture",
				importance: 0.5,
				confidence: 1,
			}),
			{ stopReason: "toolUse" },
		),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("fixture write rejected");
			return fauxAssistantMessage("Write failed.");
		},
	]);
	await (await agent.submit({ chatGuid: "chat", guid: "failed", text: "Save memory." })).wait(
		BACKGROUND_CONTEXT,
	);
	const calls = await readFile(join(memoryRoot, "calls.jsonl"), "utf8");
	expect(calls.trim().split("\n")).toHaveLength(1);
	expect(calls).not.toContain("--event-time");
	await writeFile(join(memoryRoot, "responses.json"), JSON.stringify({ ...responses, wait: true }));
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("load_memory", { namespaces: ["fixture/one"] }), {
			stopReason: "toolUse",
		}),
	]);
	const submission = await agent.submit({ chatGuid: "chat", guid: "cancelled", text: "Start a slow load." });
	await vi.waitFor(() => access(join(memoryRoot, "started")), { timeout: 5000 });
	const record = await submission.status(BACKGROUND_CONTEXT);
	const conversation = await agent.harness.conversation(record.conversationId, BACKGROUND_CONTEXT);
	if (!conversation) throw new Error("Missing conversation");
	await conversation.abort(BACKGROUND_CONTEXT);
	expect(await submission.wait(BACKGROUND_CONTEXT)).toMatchObject({
		status: "unanswered",
		reason: "aborted",
	});
	await vi.waitFor(() => access(join(memoryRoot, "terminated")), { timeout: 5000 });
	await expect(access(join(memoryRoot, "late-write"))).rejects.toThrow();
	expect(faux.state.callCount).toBe(5);
});
