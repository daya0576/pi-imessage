import { access, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { Harness } from "@earendil-works/pi-durable";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Chats, WatchCursor } from "../src/agent/chats.ts";
import type { SendText } from "../src/agent/deliver.ts";
import { Deliveries } from "../src/agent/replies.ts";
import { startMessaging, startService } from "../src/main.ts";
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
	const clearInterval = vi.spyOn(globalThis, "clearInterval");
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
	const compaction = intervals.mock.calls.findIndex(([, duration]) => duration === 6 * 60 * 60 * 1000);
	expect(compaction).toBeGreaterThanOrEqual(0);
	await service.close();
	expect(clearInterval).toHaveBeenCalledWith(intervals.mock.results[compaction].value);
});

// #33 Phase 2: exercise real local HEIC conversion and image reading without storing image bytes.
it("retries a broken HEIC, archives JPEG and reads the image only in the model request", async () => {
	// #33 Phase 3: use the default product tool set, not an explicitly injected image extension.
	options.extensions = undefined;
	options.intervalMs = 60_000;
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
			return fauxAssistantMessage("image read");
		},
	]);
	await service.poll();
	await vi.waitFor(async () => {
		await service?.poll();
		expect(send).toHaveBeenCalledTimes(1);
	});
	expect(textCalls()).toEqual([["iMessage;-;dm", "image read"]]);
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
	expect((await service.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(rowid);
});

// #33 Phase 3: command rows must settle without becoming model input or blocking following source rows.
it("routes commands separately and advances to the following ordinary message", async () => {
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
