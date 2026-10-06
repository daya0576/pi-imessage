import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CompactionTask, Harness } from "@earendil-works/pi-durable";
import Database from "better-sqlite3";
import sharp from "sharp";
import { getGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Chats, WatchCursor } from "../src/agent/chats.ts";
import { compactChats } from "../src/agent/compaction.ts";
import type { SendText } from "../src/agent/deliver.ts";
import { DirectSends } from "../src/agent/direct-send.ts";
import * as modelConfig from "../src/agent/models.ts";
import { argumentSummary, commandPreview, formatProgress } from "../src/agent/progress-format.ts";
import { Deliveries } from "../src/agent/replies.ts";
import { Schedules } from "../src/agent/scheduling.ts";
import { startApplication, startMessaging, startService } from "../src/main.ts";
import * as httpTransport from "../src/transport/http.ts";
import { createWatcher } from "../src/transport/watch.ts";

let directory: string;
let database: Database.Database;
let options: Parameters<typeof startMessaging>[0];
let service: Awaited<ReturnType<typeof startMessaging>> | undefined;
let faux: FauxProviderHandle;
const send = vi.fn<SendText>();
const textCalls = () => send.mock.calls.map(([chatGuid, text]) => [chatGuid, text]);
const onError = vi.fn<(error: unknown) => void>();

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "imessage-messaging-"));
	const dbPath = join(directory, "messages.db");
	database = new Database(dbPath);
	database.exec(`
		CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER DEFAULT 0,
			associated_message_type INTEGER DEFAULT 0, service TEXT DEFAULT 'iMessage',
			thread_originator_guid TEXT, handle_id INTEGER DEFAULT 1);
		CREATE TABLE handle (id TEXT);
		CREATE TABLE chat (guid TEXT, display_name TEXT);
		CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
		CREATE TABLE attachment (filename TEXT);
		CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
		INSERT INTO handle VALUES ('sender');
		INSERT INTO chat VALUES ('iMessage;-;dm',''), ('iMessage;+;group','Team'), ('SMS;-;sms',''), ('disabled','');
	`);
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			chatAllowlist: { whitelist: ["*"], blacklist: ["disabled"] },
		}),
	);
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	send.mockReset().mockResolvedValue(undefined);
	onError.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	options = {
		workingDir: directory,
		agentDir: join(directory, "agent"),
		dbPath,
		intervalMs: 10,
		onError,
		runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
		extensions: () => [],
		send,
		sendAttachment: vi.fn().mockRejectedValue(new Error("Unexpected attachment send")),
	};
});

afterEach(async () => {
	await service?.close();
	service = undefined;
	database.close();
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
});

function insert(guid: string, text: string | null, chat = 1) {
	const rowid = Number(
		database.prepare("INSERT INTO message(guid,text) VALUES (?,?)").run(guid, text).lastInsertRowid,
	);
	database.prepare("INSERT INTO chat_message_join VALUES (?,?)").run(rowid, chat);
	return rowid;
}

// #33 Phase 2: test our polling, routing and attachment boundaries, not the Messages service.
it("automatically routes DM, group and SMS, archives attachments and logs disabled chats", async () => {
	const intervals = vi.spyOn(globalThis, "setInterval");
	const contexts: TranscriptContext[] = [];
	const reply = (context: TranscriptContext) => {
		contexts.push(context);
		return fauxAssistantMessage([
			{ type: "thinking", thinking: "private" },
			{ type: "text", text: "commentary", textSignature: JSON.stringify({ v: 1, phase: "commentary" }) },
			{ type: "text", text: "final answer" },
		]);
	};
	faux.setResponses([reply, reply, reply]);
	service = await startMessaging(options);
	const source = join(directory, "picture.png");
	await writeFile(source, "fixture bytes, never opened by an image tool");
	insert("dm", "first");
	const group = insert("group", "second", 2);
	database.prepare("UPDATE message SET thread_originator_guid='dm' WHERE ROWID=?").run(group);
	database.prepare("INSERT INTO attachment VALUES (?)").run(source);
	database.prepare("INSERT INTO message_attachment_join VALUES (?,1)").run(group);
	const sms = insert("sms", null, 3);
	// Small attributedBody fixture for the legacy NSString decoder.
	database
		.prepare("UPDATE message SET service='SMS',attributedBody=? WHERE ROWID=?")
		.run(Buffer.concat([Buffer.from("NSString+"), Buffer.from([5]), Buffer.from("third")]), sms);
	insert("disabled", "logged only", 4);
	const own = insert("own", "do not echo");
	database.prepare("UPDATE message SET is_from_me=1 WHERE ROWID=?").run(own);
	const reaction = insert("reaction", "do not answer a reaction");
	database.prepare("UPDATE message SET associated_message_type=2000 WHERE ROWID=?").run(reaction);
	const last = insert("empty", "");
	// Concurrent full-suite JSONL/fsync work can exceed the default one-second wait.
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3), { timeout: 5000 });
	await service.poll();
	expect(textCalls()).toEqual(
		expect.arrayContaining([
			["iMessage;-;dm", "final answer"],
			["iMessage;+;group", "final answer"],
			["SMS;-;sms", "final answer"],
		]),
	);
	const prompts = JSON.stringify(contexts);
	expect(prompts).toContain("[DM from sender] first");
	expect(prompts).toContain("[Group 'Team' from sender] [replying to:");
	expect(prompts).toContain("[SMS from sender] third");
	expect(prompts).not.toContain("logged only");
	expect(prompts).not.toContain(source);
	expect(prompts).toContain(join(directory, "attachments", encodeURIComponent("iMessage;+;group")));
	const chats = await service.harness.snapshot(Chats, BACKGROUND_CONTEXT);
	const disabled = chats?.items.find((chat) => chat.chatGuid === "disabled");
	if (!disabled) throw new Error("Missing logged chat");
	const conversation = await service.harness.conversation(disabled.conversationId, BACKGROUND_CONTEXT);
	const entries = await conversation?.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	expect(JSON.stringify(entries)).toContain("logged only");
	expect(faux.state.callCount).toBe(3);
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(last);
	expect(onError).not.toHaveBeenCalled();
	expect(intervals.mock.calls.some(([, duration]) => duration === 6 * 60 * 60 * 1000)).toBe(false);
	const schedules = (await service.harness.snapshot(Schedules, BACKGROUND_CONTEXT))?.items;
	expect(schedules).toHaveLength(1);
	if (!schedules?.[0]) throw new Error("Missing scheduled compaction");
	expect(await service.harness.getTask(schedules[0].taskId, BACKGROUND_CONTEXT)).toMatchObject({
		kind: "imessage.schedule",
		background: true,
	});
	await service.close();
});

// #33 Phase 2: exercise real local HEIC conversion and image reading without storing image bytes.
it("retries a broken HEIC, archives JPEG and reads the image only in the model request", async () => {
	// #33 Phase 3: use the default product tool set, not an explicitly injected image extension.
	options.extensions = undefined;
	options.intervalMs = 60_000;
	const trap = join(directory, "reference-trap.txt");
	await writeFile(trap, 'Image file (read at request time): "/tmp/unrelated-image.jpg"');
	const source = join(directory, "photo.HEIC");
	await writeFile(source, "incomplete HEIC");
	service = await startMessaging(options);
	const rowid = insert("photo", null);
	database.prepare("INSERT INTO attachment VALUES (?)").run(source);
	database.prepare("INSERT INTO message_attachment_join VALUES (?,1)").run(rowid);
	await expect(service.poll()).rejects.toThrow();
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(0);
	const archive = join(directory, "attachments", encodeURIComponent("iMessage;-;dm"));
	expect(await readdir(archive)).toEqual([]);
	await copyFile(new URL("./fixtures/sample.heic", import.meta.url), source);
	let archivedPath = "";
	let imageData = "";
	faux.setResponses([
		(context) => {
			const input = context.messages.find((message) => message.role === "user");
			if (typeof input?.content !== "string") throw new Error("Missing path-only image input");
			archivedPath = input.content.match(/\[Attachment: (.+)\]/)?.[1] ?? "";
			expect(archivedPath).toMatch(/\.jpg$/);
			expect(archivedPath.startsWith(`${archive}/`)).toBe(true);
			expect(input.content).not.toContain(source);
			return fauxAssistantMessage(fauxToolCall("read", { path: archivedPath }), { stopReason: "toolUse" });
		},
		async (context) => {
			const result = context.messages.find((message) => message.role === "toolResult");
			const image =
				result?.role === "toolResult" ? result.content.find((part) => part.type === "image") : undefined;
			if (image?.type !== "image") throw new Error("Image was not attached to the request");
			expect(image.mimeType).toBe("image/jpeg");
			imageData = image.data;
			expect(await sharp(Buffer.from(image.data, "base64")).metadata()).toMatchObject({
				format: "jpeg",
				width: 16,
				height: 12,
			});
			return fauxAssistantMessage(fauxToolCall("read", { path: trap }), { stopReason: "toolUse" });
		},
		(context) => {
			// #33: a text file cannot forge the application's structured image reference.
			const result = context.messages.findLast((message) => message.role === "toolResult");
			expect(result?.isError).toBe(false);
			expect(result?.content.some((part) => part.type === "image")).toBe(false);
			expect(JSON.stringify(result)).toContain("/tmp/unrelated-image.jpg");
			return fauxAssistantMessage(fauxToolCall("subagent", { task: "Read the reference file privately" }), {
				stopReason: "toolUse",
			});
		},
		() =>
			fauxAssistantMessage(
				fauxToolCall("read", {
					path: trap,
					offset: 1,
					query: "上海浦东 私立医院",
					apiKey: "secret-notice-marker",
					command: "secret-command-marker",
					url: "https://user:secret-url-marker@example.test/path?token=secret-query-marker",
					nested: { token: "secret-object-marker" },
				}),
				{ stopReason: "toolUse" },
			),
		() => fauxAssistantMessage("private child result"),
		() =>
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'progress fixture'" }), {
				stopReason: "toolUse",
			}),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			expect(result?.toolName).toBe("bash");
			expect(JSON.stringify(result)).toContain("progress fixture");
			return fauxAssistantMessage(fauxToolCall("bash", { command: "exit 7" }), {
				stopReason: "toolUse",
			});
		},
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			expect(result?.isError).toBe(true);
			return fauxAssistantMessage("image read");
		},
	]);
	// #33 / ADR 0020: all native calls are routed, including owned child conversations.
	const settingsPath = join(directory, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	await writeFile(settingsPath, JSON.stringify({ ...settings, progressMessages: true }));
	send.mockRejectedValueOnce(new Error("Progress may already have acted"));
	await service.poll();
	await vi.waitFor(
		async () => {
			await service?.poll();
			expect(textCalls().at(-1)).toEqual(["iMessage;-;dm", "image read"]);
		},
		{ timeout: 5000 },
	);
	const notices = textCalls();
	expect(notices.every(([chat]) => chat === "iMessage;-;dm")).toBe(true);
	expect(notices.filter(([, text]) => text.startsWith("→ [tool] "))).toHaveLength(5);
	expect(notices.filter(([, text]) => text.startsWith("→ [subagent/tool] "))).toHaveLength(1);
	expect(notices.map(([, text]) => text).join("\n")).toContain(`path=${trap}`);
	const progressText = notices.map(([, text]) => text).join("\n");
	expect(progressText).not.toContain("Read the reference file privately");
	expect(progressText).not.toContain("pi.generation");
	expect(progressText).not.toMatch(/\[(?:task|tool) #\d+/);
	expect(progressText).toContain("query=上海浦东 私立医院");
	expect(progressText).not.toMatch(/secret-(notice|command|url|query|object)-marker/);
	expect(progressText).toContain("apiKey=[redacted]");
	expect(progressText).toContain("url=example．test");
	expect(progressText).toContain("→ [tool] bash: printf 'progress fixture'");
	expect(notices.filter(([, text]) => text.startsWith("✓ "))).toHaveLength(5);
	expect(notices.filter(([, text]) => text.startsWith("× "))).toEqual([
		["iMessage;-;dm", expect.stringMatching(/^× \[tool\] bash \(\d+\.\ds\)$/)],
	]);
	expect(progressText).toMatch(/✓ \[subagent\/tool\] read \(\d+\.\ds\)/);
	expect(progressText).toContain("printf 'progress fixture'");
	expect(progressText).not.toContain("(bash");
	expect(progressText).toContain("→ [tool] read: path=");
	expect(progressText).toContain("→ [subagent/tool] read: path=");
	expect(progressText).toMatch(/✓ \[tool\] bash \(\d+\.\ds\)/);
	expect(
		formatProgress({
			type: "tool",
			parents: [],
			name: "bash",
			phase: "request",
			summary: "查上海天气",
			commandPreview: "printf hi",
		}),
	).toBe("→ [tool] bash: printf hi");
	expect(
		formatProgress({
			type: "tool",
			parents: [],
			name: "bash",
			phase: "response",
			success: true,
			elapsedMs: 800,
		}),
	).toBe("✓ [tool] bash (0.8s)");
	expect(commandPreview("printf hi")).toBe("printf hi");
	expect(commandPreview("x".repeat(120))).toBe("x".repeat(120));
	expect(commandPreview("printf\n  hi")).toBe("printf hi");
	expect(commandPreview("x".repeat(121))).toBe(`${"x".repeat(119)}…`);
	expect(Array.from(commandPreview("汉".repeat(121)))).toHaveLength(120);
	expect(commandPreview(`${"x".repeat(200)} token=secret-command-marker`)).not.toContain(
		"secret-command-marker",
	);
	// #36: Keep command structure while masking credential values, not keywords.
	expect(commandPreview("curl https://user:secret-url-marker@example.test")).toBe(
		"curl https：／／***@example．test",
	);
	expect(commandPreview("cat ~/.env auth.json id_rsa")).toBe("cat ~/.env auth.json id_rsa");
	expect(commandPreview("rg 'token|password|secret' src")).toBe("rg 'token|password|secret' src");
	for (const [command, preview] of [
		["TOKEN=secret-command-marker curl --retry 3", "TOKEN=*** curl --retry 3"],
		['curl --api-key "secret-command-marker with spaces" --retry 3', "curl --api-key *** --retry 3"],
		["curl -u user:secret-command-marker --retry 3", "curl -u *** --retry 3"],
		["curl --user 'user:secret-command-marker'", "curl --user ***"],
		["curl --user=user:secret-command-marker", "curl --user=***"],
		["curl --password=secret-command-marker", "curl --password=***"],
		[
			'curl -H "Authorization: Bearer secret-command-marker" --retry 3',
			'curl -H "Authorization: ***" --retry 3',
		],
		['curl -H "Authorization: Basic secret-command-marker"', 'curl -H "Authorization: ***"'],
		['printf \'{"api_key":"secret-command-marker"}\'', 'printf \'{"api_key":"***"}\''],
		["TOKEN=abc'quoted'\\ space curl", "TOKEN=*** curl"],
		['TOKEN="abc\\"quoted" curl', "TOKEN=*** curl"],
		[
			"curl https://example.com/?token=secret-command-marker&limit=5",
			"curl https：／／example．com／?token=***&limit=5",
		],
		["echo github_pat_fakefixture", "echo ***"],
		["echo sk-fakefixture", "echo ***"],
		[
			"printf '-----BEGIN PRIVATE KEY-----\nsecret-command-marker\n-----END PRIVATE KEY-----'",
			"printf '***'",
		],
		["curl --user \\\n  user:secret-command-marker --retry 3", "curl --user *** --retry 3"],
		['curl "--password" secret-command-marker', 'curl "--password" ***'],
		["TOKEN=$(printf %s secret-command-marker) curl", "TOKEN=*** curl"],
		["TOKEN=`printf %s secret-command-marker` curl", "TOKEN=*** curl"],
		['curl -H "Authorization: Bearer "secret-command-marker', 'curl -H "Authorization: ***'],
		['curl "https://user:pa\'ss@example.test"', 'curl "https：／／***@example．test"'],
		['printf \'{"password":1234,"keep":5}\'', 'printf \'{"password":***,"keep":5}\''],
		['curl -d "{\\"password\\":\\"secret-command-marker\\"}" --retry 3', "curl -d *** --retry 3"],
		[`TOKEN=${"s".repeat(200)} curl`, "TOKEN=*** curl"],
	]) {
		expect(commandPreview(command)).toBe(preview);
	}
	expect(commandPreview("curl https://example.com/path")).toBe("curl https：／／example．com／path");
	expect(commandPreview("curl example.com/path")).toBe("curl example．com/path");
	expect(progressText).not.toContain("timeout=");
	expect(progressText).not.toContain("https://");
	expect(argumentSummary({ query: "来源 https://example.test/private" })).not.toContain("https://");
	expect(notices.at(-1)).toEqual(["iMessage;-;dm", "image read"]);
	const receipts = (await service.harness.snapshot(DirectSends, BACKGROUND_CONTEXT))?.requests ?? [];
	expect(receipts.filter((receipt) => receipt.requestId.startsWith("progress:"))).toHaveLength(12);
	expect(receipts.filter((receipt) => receipt.textStatus === "unknown")).toHaveLength(1);
	expect(await sharp(archivedPath).metadata()).toMatchObject({ format: "jpeg", width: 16, height: 12 });
	expect(await readdir(archive)).toHaveLength(1);
	expect(imageData).not.toBe("");
	const chat = (await service.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items[0];
	if (!chat) throw new Error("Missing chat history");
	const conversation = await service.harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
	const history = JSON.stringify(await conversation?.entries({}, 100, undefined, BACKGROUND_CONTEXT));
	expect(history).toContain(archivedPath);
	expect(history).not.toContain(imageData);
	expect(history).not.toContain('"type":"image"');
	expect(history).not.toContain("→ bash:");
	expect(history).not.toContain("✓ bash");
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(rowid);
	await service.close();
	service = await startMessaging(options);
	await service.poll();
	expect(send).toHaveBeenCalledTimes(13); // No historical or uncertain notice replay.
	faux.setResponses([fauxAssistantMessage("healthy"), fauxAssistantMessage("quiet answer")]);
	await service.health();
	await service.poll();
	expect(send).toHaveBeenCalledTimes(13); // Tool-less health remains private.
	await writeFile(settingsPath, JSON.stringify({ ...settings, progressMessages: false }));
	insert("quiet", "Another question");
	await service.poll();
	await vi.waitFor(async () => {
		await service?.poll();
		expect(send).toHaveBeenCalledTimes(14);
	});
	expect(textCalls().at(-1)).toEqual(["iMessage;-;dm", "quiet answer"]);
});

// #33 Phase 3: command rows must settle without becoming model input or blocking following source rows.
it("routes commands and hides only six-hour compaction progress", async () => {
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] }, progressMessages: true }),
	);
	faux.setResponses([fauxAssistantMessage("ordinary reply")]);
	service = await startMessaging(options);
	insert("help", "/help");
	insert("stop", "/stop");
	insert("thinking", "/thinking high");
	const last = insert("after-commands", "Ordinary question after commands.");
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
	expect(textCalls().map(([, text]) => text)).toEqual([
		expect.stringContaining("/help"),
		"Nothing is running.",
		"Thinking: high (this chat only)",
		"ordinary reply",
	]);
	expect(faux.state.callCount).toBe(1);
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(last);
	// Scheduled native compactions emit neither admission nor settlement notices.
	const tasks = await compactChats(service.harness);
	expect(tasks).toHaveLength(1);
	for (const task of tasks) await service.harness.waitForTask(task, BACKGROUND_CONTEXT);
	await service.poll();
	expect(send).toHaveBeenCalledTimes(4);
	expect((await service.harness.snapshot(DirectSends, BACKGROUND_CONTEXT))?.requests ?? []).not.toEqual(
		expect.arrayContaining([expect.objectContaining({ requestId: expect.stringMatching(/^progress:/) })]),
	);
	// Explicit /compact retains both progress phases and its command result.
	insert("manual-compact", "/compact");
	await vi.waitFor(async () => {
		await service?.poll();
		expect(send).toHaveBeenCalledTimes(7);
	});
	expect(textCalls()).toEqual(
		expect.arrayContaining([
			["iMessage;-;dm", "Nothing to compact."],
			["iMessage;-;dm", "→ [task] pi.compaction"],
			["iMessage;-;dm", expect.stringMatching(/^✓ \[task\] pi\.compaction \(\d+\.\ds\)$/)],
		]),
	);
	const chat = (await service.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items[0];
	if (!chat) throw new Error("Missing chat");
	// Native task fixtures exercise routing for automatic threshold/overflow admission and settlement.
	for (const reason of ["threshold", "overflow"] as const) {
		const task = await service.harness.commit(
			(tx) =>
				tx.createTask(
					CompactionTask,
					{ reason },
					{
						conversationId: chat.conversationId,
						ownership: { kind: "conversation" },
					},
				),
			BACKGROUND_CONTEXT,
		);
		await service.harness.waitForTask(task, BACKGROUND_CONTEXT);
		await vi.waitFor(async () => {
			if (!service) throw new Error("Missing service");
			const receipts = (await service.harness.snapshot(DirectSends, BACKGROUND_CONTEXT))?.requests ?? [];
			expect(receipts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						requestId: `progress:${task}`,
						text: "→ [task] pi.compaction",
						textStatus: "sent",
					}),
					expect.objectContaining({
						requestId: `progress:${task}:done`,
						text: expect.stringMatching(/^✓ \[task\] pi\.compaction \(\d+\.\ds\)$/),
						textStatus: "sent",
					}),
				]),
			);
		});
	}
	expect(send).toHaveBeenCalledTimes(11);
	expect(onError).not.toHaveBeenCalled();
});

// #33 Phase 2: save the initial high-water mark even if no row has been accepted yet.
it("skips pre-start history but reads downtime rows after reopening without repeating a send", async () => {
	const old = insert("old", "pre-start history");
	service = await startMessaging(options);
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(old);
	await service.close();
	insert("downtime", "arrived while stopped");
	faux.setResponses([fauxAssistantMessage("reply after restart")]);
	service = await startMessaging(options);
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	await service.close();
	service = await startMessaging(options);
	await Promise.all([service.poll(), service.poll()]);
	expect(textCalls()).toEqual([["iMessage;-;dm", "reply after restart"]]);
	expect(faux.state.callCount).toBe(1);
	expect(onError).not.toHaveBeenCalled();
});

// #33 Phase 2: failed acceptance must not advance past the row or strand an already completed answer.
it("holds a failed attachment row, delivers saved work and retries admission after repair", async () => {
	options.intervalMs = 60_000;
	const manual = await startService(options);
	try {
		faux.setResponses([fauxAssistantMessage("saved while blocked")]);
		await (await manual.submit({ chatGuid: "iMessage;-;dm", guid: "saved", text: "hello" })).wait(
			BACKGROUND_CONTEXT,
		);
	} finally {
		await manual.close();
	}
	service = await startMessaging(options);
	const source = join(directory, "not-downloaded.png");
	const rowid = insert("attachment", null);
	database.prepare("INSERT INTO attachment VALUES (?)").run(source);
	database.prepare("INSERT INTO message_attachment_join VALUES (?,1)").run(rowid);
	await expect(service.poll()).rejects.toMatchObject({ code: "ENOENT" });
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(0);
	expect(faux.state.callCount).toBe(1);
	expect(textCalls()).toEqual([["iMessage;-;dm", "saved while blocked"]]);
	await writeFile(source, "download finished");
	faux.setResponses([fauxAssistantMessage("image received")]);
	await service.poll();
	await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
	await vi.waitFor(async () => {
		await service?.poll();
		expect(send).toHaveBeenCalledTimes(2);
	});
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(rowid);
	expect(textCalls()).toEqual([
		["iMessage;-;dm", "saved while blocked"],
		["iMessage;-;dm", "image received"],
	]);
});

// #33 Phase 2: the automatic host must use saved reply receipts, not regenerate the answer.
it("automatically sends a saved unattempted answer and leaves an interrupted send unknown", async () => {
	const manual = await startService(options);
	try {
		faux.setResponses([fauxAssistantMessage("saved"), fauxAssistantMessage("uncertain")]);
		await (await manual.submit({ chatGuid: "iMessage;-;dm", guid: "saved", text: "one" })).wait(
			BACKGROUND_CONTEXT,
		);
		const uncertain = await (
			await manual.submit({ chatGuid: "iMessage;+;group", guid: "uncertain", text: "two" })
		).wait(BACKGROUND_CONTEXT);
		if (uncertain.status !== "done" || uncertain.type !== "input") throw new Error("Expected answer");
		await manual.harness.commit(async (tx) => {
			(await tx.doc(Deliveries, uncertain.conversationId)).answers[String(uncertain.answer)] = "sending";
		}, BACKGROUND_CONTEXT);
	} finally {
		await manual.close();
	}
	const open = Harness.open;
	const resume = vi.fn<() => void>();
	vi.spyOn(Harness, "open").mockImplementationOnce(async (...args) => {
		const harness = await open(...args);
		const original = harness.resume.bind(harness);
		vi.spyOn(harness, "resume").mockImplementation(() => {
			resume();
			original();
		});
		return harness;
	});
	service = await startMessaging(options);
	expect(resume).toHaveBeenCalledTimes(1);
	await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	await service.poll();
	expect(resume).toHaveBeenCalledTimes(1);
	expect(textCalls()).toEqual([["iMessage;-;dm", "saved"]]);
	expect(faux.state.callCount).toBe(2);
	expect(console.warn).toHaveBeenCalledWith("Reply delivery unknown", expect.anything(), expect.any(String));
});

// #33 Phase 2: DB bootstrap failure and shutdown must not leak the storage owner or polling work.
it("releases ownership on watcher failure and joins an in-flight automatic send on close", async () => {
	await expect(startMessaging({ ...options, dbPath: join(directory, "missing.db") })).rejects.toThrow();
	await expect(access(join(directory, "durable", "owner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
	const gate = Promise.withResolvers<void>();
	const sending = Promise.withResolvers<void>();
	send.mockImplementation(async () => {
		sending.resolve();
		await gate.promise;
	});
	faux.setResponses([fauxAssistantMessage("reply")]);
	service = await startMessaging(options);
	insert("active", "hello");
	await sending.promise;
	try {
		const closing = service.close();
		expect(service.close()).toBe(closing);
		await expect(service.poll()).rejects.toThrow("closed");
		await expect(startMessaging(options)).rejects.toMatchObject({ code: "EEXIST" });
		gate.resolve();
		await closing;
		service = await startMessaging(options);
		await service.poll();
		expect(send).toHaveBeenCalledTimes(1);
	} finally {
		gate.resolve();
	}
	await service.close();
	service = undefined;
	// #33 / ADR 0016: production wiring installs HTTP before auth, reloads it and cleans up failures.
	const previousDispatcher = getGlobalDispatcher();
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"])
		vi.stubEnv(name, "");
	await mkdir(options.agentDir, { recursive: true });
	await mkdir(join(directory, ".pi"), { recursive: true });
	await writeFile(join(options.agentDir, "auth.json"), "{}");
	await writeFile(join(options.agentDir, "models.json"), "{}");
	await writeFile(
		join(options.agentDir, "settings.json"),
		JSON.stringify({ httpProxy: "http://127.0.0.1:1", httpIdleTimeoutMs: 100 }),
	);
	await writeFile(
		join(directory, ".pi", "settings.json"),
		JSON.stringify({ httpProxy: "http://project.invalid:1234", httpIdleTimeoutMs: 0 }),
	);
	const openTransport = vi.spyOn(httpTransport, "openHttpTransport");
	const openModels = vi.spyOn(modelConfig, "openModels").mockImplementation(async () => {
		expect(getGlobalDispatcher()).not.toBe(previousDispatcher);
		throw new Error("isolated auth failure");
	});
	// #33 / ADR 0019: stale task configuration must not create workers or mutate stored state.
	await mkdir(join(directory, "cron"));
	await mkdir(join(directory, "automation"));
	const retiredState = [
		"cron/jobs.json",
		"automation/jobs.json",
		"reminders.db",
		"scheduled-prompts.db",
		"background.db",
	];
	for (const path of retiredState) await writeFile(join(directory, path), "retained invalid fixture");
	const applicationOptions = { ...options, web: false as const };
	let application: Awaited<ReturnType<typeof startApplication>> | undefined;
	try {
		const logs = vi.mocked(console.log);
		logs.mockClear();
		await expect(startApplication({ ...applicationOptions, runtime: undefined })).rejects.toThrow(
			"isolated auth failure",
		);
		expect(logs.mock.calls.map(([, event]) => event)).toEqual([
			"Application starting",
			"Application resources closed",
		]);
		logs.mockClear();
		await expect(
			startApplication({ ...applicationOptions, web: { host: "127.0.0.1", port: -1 } }),
		).rejects.toThrow();
		expect(logs.mock.calls.map(([, event]) => event)).toEqual([
			"Application starting",
			"Agent ready",
			"Application resources closed",
		]);
		logs.mockClear();
		expect(getGlobalDispatcher()).toBe(previousDispatcher);
		expect(openTransport).toHaveBeenLastCalledWith({ proxy: "http://127.0.0.1:1", idleTimeoutMs: 0 });
		// Injected runtimes do not install a process dispatcher, even in the full application.
		application = await startApplication(applicationOptions);
		expect(logs.mock.calls.map(([, event]) => event)).toEqual([
			"Application starting",
			"Agent ready",
			"Web server disabled",
			"Messaging ready",
			"Application started",
		]);
		expect(logs).toHaveBeenCalledWith(expect.any(String), "Messaging ready", {
			cursor: expect.any(Number),
			intervalMs: options.intervalMs,
			scheduling: "durable-background-tasks",
		});
		for (const [timestamp] of logs.mock.calls)
			expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(getGlobalDispatcher()).toBe(previousDispatcher);
		expect(openTransport).toHaveBeenCalledTimes(1);
		await application.close();
		await application.close();
		expect(logs.mock.calls.filter(([, event]) => event === "Application resources closed")).toHaveLength(1);
		application = undefined;
		const installed = await ModelRuntime.create({
			authPath: join(options.agentDir, "auth.json"),
			modelsPath: join(options.agentDir, "models.json"),
			refreshOnCreate: false,
		});
		vi.spyOn(installed, "getModel").mockReturnValue(faux.getModel());
		const stream = vi.spyOn(installed, "streamSimple").mockImplementation(() => {
			throw new Error("Unexpected model request");
		});
		openModels.mockResolvedValue(installed);
		if (!options.runtime) throw new Error("Missing isolated defaults");
		vi.spyOn(modelConfig, "readDefaults").mockResolvedValue(options.runtime.defaults);
		logs.mockClear();
		application = await startApplication({
			...applicationOptions,
			runtime: undefined,
			web: { host: "127.0.0.1", port: 0 },
		});
		expect(logs.mock.calls.map(([, event]) => event)).toEqual([
			"Application starting",
			"Agent ready",
			"Web server listening",
			"Messaging ready",
			"Application started",
		]);
		expect(logs).toHaveBeenCalledWith(expect.any(String), "Web server listening", {
			host: "127.0.0.1",
			port: application.web?.address.port,
		});
		expect(application.web?.address.port).toBeGreaterThan(0);
		logs.mockClear();
		await application.messaging.poll();
		expect(logs).not.toHaveBeenCalled();
		const beforeReload = getGlobalDispatcher();
		await writeFile(
			join(options.agentDir, "settings.json"),
			JSON.stringify({ httpProxy: "http://127.0.0.1:2", httpIdleTimeoutMs: 100 }),
		);
		const owned = openTransport.mock.results[1].value as ReturnType<typeof httpTransport.openHttpTransport>;
		const reload = vi.spyOn(owned, "reload");
		insert("reload-http", "/reload");
		await application.messaging.poll();
		expect(reload).toHaveBeenCalledWith({ proxy: "http://127.0.0.1:2", idleTimeoutMs: 0 });
		expect(logs).toHaveBeenCalledWith(expect.any(String), "Agent reloaded", {
			model: options.runtime.defaults.model,
		});
		expect(JSON.stringify(logs.mock.calls)).not.toContain("http://127.0.0.1:2");
		expect(getGlobalDispatcher()).not.toBe(beforeReload);
		expect(stream).not.toHaveBeenCalled();
		for (const path of retiredState)
			expect(await readFile(join(directory, path), "utf8")).toBe("retained invalid fixture");
		expect(await readdir(join(directory, "automation"))).toEqual(["jobs.json"]);
		expect(await readdir(join(directory, "cron"))).toEqual(["jobs.json"]);
		await application.close();
		expect(getGlobalDispatcher()).toBe(previousDispatcher);
	} finally {
		await application?.close();
		vi.unstubAllEnvs();
	}
});

// #33 Phase 2: cursor writes happen only after durable acceptance, and a failed write reuses the source GUID.
it("does not advance its local cursor when admission or cursor persistence fails", async () => {
	const rowid = insert("stable-guid", "hello");
	const accept = vi
		.fn<(message: { guid: string }) => Promise<void>>()
		.mockRejectedValueOnce(new Error("admission failed"))
		.mockResolvedValue(undefined);
	const saveCursor = vi
		.fn<(rowid: number) => Promise<void>>()
		.mockRejectedValueOnce(new Error("cursor failed"))
		.mockResolvedValue(undefined);
	const watcher = createWatcher({ dbPath: options.dbPath, cursor: 0, accept, saveCursor, onError });
	try {
		await expect(watcher.poll()).rejects.toThrow("admission failed");
		expect(saveCursor).not.toHaveBeenCalled();
		await expect(watcher.poll()).rejects.toThrow("cursor failed");
		expect(watcher.cursor).toBe(0);
		await watcher.poll();
		expect(watcher.cursor).toBe(rowid);
		expect(accept.mock.calls.map(([message]) => message.guid)).toEqual([
			"stable-guid",
			"stable-guid",
			"stable-guid",
		]);
		await watcher.poll();
		expect(accept).toHaveBeenCalledTimes(3);
	} finally {
		const stopping = watcher.stop();
		expect(watcher.stop()).toBe(stopping);
		await stopping;
	}
	expect(() =>
		createWatcher({ dbPath: options.dbPath, cursor: rowid + 1, accept, saveCursor, onError }),
	).toThrow("reconcile");
	// The fixture remains readable; all failed-open SQLite handles have been closed.
	expect((await readFile(options.dbPath)).length).toBeGreaterThan(0);
});
