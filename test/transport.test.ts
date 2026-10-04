import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMessageSender } from "../src/transport/send.ts";

// Fail closed: these tests must never execute Swift, AppleScript, open, or sqlite3.
const { execute } = vi.hoisted(() => ({
	execute:
		vi.fn<
			(
				file: string,
				args: string[],
				options: { timeout: number },
			) => Promise<{ stdout: string; stderr: string }>
		>(),
}));
vi.mock("node:child_process", () => ({
	execFile: Object.assign(
		() => {
			throw new Error("Native execution disabled in transport tests");
		},
		{
			[promisify.custom]: execute,
		},
	),
}));

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "imessage-transport-"));
	execute.mockReset().mockRejectedValue(new Error("Unexpected native command"));
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
});

// #33 Phase 2: the clipboard/focused chat cannot be shared by overlapping rich sends.
it("serializes rich sends across senders and releases the queue after an uncertain failure without fallback", async () => {
	const gate = Promise.withResolvers<void>();
	const pasting = Promise.withResolvers<void>();
	const spans: unknown[] = [];
	const helpers: string[] = [];
	let pasteCount = 0;
	execute.mockImplementation(async (file, args) => {
		if (file === "swift") {
			helpers.push(dirname(args[0]));
			spans.push(JSON.parse(await readFile(args[2], "utf8")));
		} else if (file === "open") {
			expect(args[0]).toMatch(/^messages:\/\/open\?addresses=/);
		} else if (file === "osascript") {
			expect(args[1]).toContain('keystroke "v" using command down');
			pasteCount++;
			if (pasteCount === 1) {
				pasting.resolve();
				await gate.promise;
				throw new Error("uncertain paste/send effect");
			}
		} else throw new Error(`Unexpected command: ${file}`);
		return { stdout: "OK", stderr: "" };
	});
	const first = createMessageSender().sendMessage("iMessage;-;first@example.test", "**first**", {
		enabled: true,
		markdown: true,
	});
	const failed = expect(first).rejects.toThrow("uncertain paste/send effect");
	const settings = { enabled: true, markdown: false };
	const second = createMessageSender().sendMessage("iMessage;-;second@example.test", "**second**", settings);
	settings.markdown = true; // Caller mutation must not change a queued send's requested formatting.
	try {
		await pasting.promise;
		expect(execute.mock.calls.map(([file]) => file)).toEqual(["swift", "open", "osascript"]);
		gate.resolve();
		await Promise.all([failed, second]);
	} finally {
		gate.resolve();
		await Promise.allSettled([first, second]);
	}
	expect(execute.mock.calls.map(([file]) => file)).toEqual([
		"swift",
		"open",
		"osascript",
		"swift",
		"open",
		"osascript",
	]);
	expect(execute.mock.calls.filter(([file]) => file === "open").map(([, args]) => args)).toEqual([
		["messages://open?addresses=first%40example.test"],
		["messages://open?addresses=second%40example.test"],
	]);
	expect(spans).toEqual([
		[{ text: "first", bold: true, italic: false, strikethrough: false }],
		[{ text: "**second**", bold: false, italic: false, strikethrough: false }],
	]);
	for (const path of helpers) await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
	// Keep the transport's existing DM-only restriction, with no UI action on rejection.
	await expect(
		createMessageSender().sendMessage("iMessage;+;group", "hello", { enabled: true, markdown: true }),
	).rejects.toThrow("direct-message");
	expect(execute).toHaveBeenCalledTimes(6);
});

// #33 Phase 2: exercise attachment staging and acknowledged/refused outcomes without a real Messages path.
it("stages files in an explicit temporary root and surfaces verification failure without repeating earlier sends", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const attachmentsRoot = join(directory, "Attachments");
	const dbPath = join(directory, "messages.db");
	const staged: string[] = [];
	let verification = 0;
	execute.mockImplementation(async (file, args) => {
		if (file === "osascript") {
			const path = args[1].match(/send POSIX file "([^"]+)"/)?.[1];
			if (path) {
				expect(path.startsWith(`${attachmentsRoot}/pi-imessage/`)).toBe(true);
				expect(await readFile(path, "utf8")).toBe("local fixture");
				staged.push(path);
			} else {
				expect(args[1]).toContain('chat id "iMessage;+;group"');
				expect(args[1]).toContain('send "already sent"');
			}
			return { stdout: "", stderr: "" };
		}
		if (file === "sqlite3") {
			expect(args[1]).toBe(dbPath);
			verification++;
			return {
				stdout: JSON.stringify([
					{
						attachment_id: verification,
						transfer_state: verification === 1 ? 5 : 6,
						is_sent: verification === 1 ? 1 : 0,
						error: 0,
					},
				]),
				stderr: "",
			};
		}
		throw new Error(`Unexpected command: ${file}`);
	});
	const filePath = join(directory, "report.txt");
	await writeFile(filePath, "local fixture");
	const sender = createMessageSender({ attachmentsRoot, dbPath });
	await sender.sendMessage("iMessage;+;group", "already sent", { enabled: false, markdown: true });
	await sender.sendAttachment("iMessage;+;group", filePath);
	await expect(sender.sendAttachment("iMessage;+;group", filePath)).rejects.toThrow("attachment send failed");
	expect(execute.mock.calls.map(([file]) => file)).toEqual([
		"osascript",
		"osascript",
		"sqlite3",
		"osascript",
		"sqlite3",
	]);
	expect(staged).toHaveLength(2);
	expect(staged[0]).not.toBe(staged[1]);
	await vi.advanceTimersByTimeAsync(60_000);
	for (const path of staged)
		await vi.waitFor(async () => {
			await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		});
	expect(await readFile(filePath, "utf8")).toBe("local fixture");
});
