import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { Chats, WatchCursor } from "../src/agent/chats.ts";
import { startService } from "../src/main.ts";
import { migrate } from "../src/migrate/migrate.ts";

// #33: backup/import/restore rehearsal uses synthetic data; imported answers must never be sent again.
it("verifies a backup, imports history and attachments once, then starts from empty context without replaying old replies", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "imessage-import-")));
	const source = join(directory, "source");
	const target = join(directory, "target");
	const backup = join(directory, "backup");
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	try {
		await mkdir(join(source, "chat", "images"), { recursive: true });
		const settings = JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } });
		await writeFile(join(source, "settings.json"), settings);
		await mkdir(join(source, "backups", "old"), { recursive: true });
		await writeFile(join(source, "backups", "old", "archive.txt"), "old backup fixture");
		await writeFile(join(source, "chat", "images", "image.png"), "synthetic bytes");
		const external = join(directory, "external.png");
		const missing = join(directory, "missing.png");
		await writeFile(external, "external synthetic bytes");
		await symlink(external, join(source, "external-link.png"));
		// Old releases keep symlinks such as releases/current; they are copied as links.
		await symlink("chat/images", join(source, "current"));
		const rows = [
			{
				date: "2026-10-01T00:00:00Z",
				sender: "fixture",
				text: "Old private detail",
				attachments: ["chat/images/image.png", "external-link.png", external, missing],
				fromAgent: false,
				messageType: "dm",
			},
			{
				date: "2026-10-01T00:01:00Z",
				sender: "bot",
				text: "Old answer",
				attachments: [],
				fromAgent: true,
				messageType: "dm",
			},
		];
		const original = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		await writeFile(join(source, "chat", "log.jsonl"), original);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const defaults = { model: { provider: model.provider, modelId: model.id } };
		// #33: external paths (including symlink escapes) and missing files require explicit approval.
		await expect(
			migrate({ source, target, backup: join(directory, "strict-backup"), cursor: 42, defaults }),
		).rejects.toThrow("Archive external attachment");
		await expect(access(target)).rejects.toThrow();
		await expect(
			migrate({
				source,
				target,
				backup: join(directory, "missing-backup"),
				cursor: 42,
				defaults,
				archiveExternalAttachments: true,
			}),
		).rejects.toThrow("ENOENT");
		await expect(access(target)).rejects.toThrow();
		// #33: reuse one frozen backup without copying it again; unrelated live files may change.
		await cp(source, backup, { recursive: true, verbatimSymlinks: true });
		await writeFile(join(source, "live-monitor.log"), "written after the snapshot");
		expect(
			await migrate({
				source,
				target,
				backup,
				cursor: 42,
				defaults,
				archiveExternalAttachments: true,
				allowMissingAttachments: true,
				reuseBackup: true,
			}),
		).toMatchObject({
			chats: 1,
			messages: 2,
		});
		expect(await readFile(join(backup, "chat", "log.jsonl"), "utf8")).toBe(original);
		expect(
			JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8")).files["chat/log.jsonl"],
		).toMatch(/^[a-f0-9]{64}$/);
		expect(await readFile(join(source, "chat", "log.jsonl"), "utf8")).toBe(original);
		expect(await readlink(join(backup, "current"))).toBe("chat/images");
		const receipt = JSON.parse(await readFile(join(target, "import-receipt.json"), "utf8"));
		expect(receipt.reusedBackup).toBe(true);
		expect(receipt.excludedWorkspaceDirectories).toEqual(["backups"]);
		await expect(access(join(target, "backups"))).rejects.toThrow();
		await expect(access(join(target, "live-monitor.log"))).rejects.toThrow();
		expect(await readFile(join(backup, "backups", "old", "archive.txt"), "utf8")).toBe("old backup fixture");
		expect(receipt.missingAttachments).toEqual([missing]);
		expect(Object.keys(receipt.archivedAttachments)).toEqual([external]);
		const archive = receipt.archivedAttachments[external];
		expect(await readFile(join(backup, archive.file), "utf8")).toBe("external synthetic bytes");
		expect(JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8")).files[archive.file]).toBe(
			archive.sha256,
		);
		expect(await readFile(external, "utf8")).toBe("external synthetic bytes");
		const restored = join(directory, "restored");
		await cp(backup, restored, { recursive: true });
		expect(await readFile(join(restored, "chat", "log.jsonl"), "utf8")).toBe(original);
		expect(await readFile(join(restored, "chat", "images", "image.png"), "utf8")).toBe("synthetic bytes");
		expect(await readFile(join(target, "settings.json"), "utf8")).toBe(settings);
		const send = vi.fn().mockResolvedValue(undefined);
		agent = await startService({
			workingDir: target,
			agentDir: join(directory, "agent"),
			runtime: { models, defaults },
			extensions: () => [],
			send,
			sendAttachment: vi.fn(),
		});
		await agent.deliver();
		expect(send).not.toHaveBeenCalled();
		expect((await agent.harness.snapshot(WatchCursor, BACKGROUND_CONTEXT))?.rowid).toBe(42);
		const chat = (await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items[0];
		if (!chat) throw new Error("Missing imported chat");
		const conversation = await agent.harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
		const history = JSON.stringify(await conversation?.entries({}, 100, undefined, BACKGROUND_CONTEXT));
		expect(history).toContain("Old answer");
		expect(history).toContain(join(target, "attachments", "chat"));
		expect(history).toContain(`[Missing attachment: ${missing}]`);
		expect(history).toContain("missingAttachments");
		faux.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("Old private detail");
				// #33: delivery facts must not reintroduce imported replies after the reset.
				expect(JSON.stringify(context.messages)).not.toContain("Old answer");
				return fauxAssistantMessage("New answer");
			},
		]);
		await (await agent.submit({ chatGuid: "chat", guid: "new", text: "A new question" })).wait(
			BACKGROUND_CONTEXT,
		);
		await agent.deliver();
		expect(send.mock.calls.map(([, text]) => text)).toEqual(["New answer"]);
		await expect(
			migrate({ source, target, backup: join(directory, "another-backup"), cursor: 42, defaults }),
		).rejects.toThrow("Target already exists");
		await expect(access(join(directory, "another-backup"))).rejects.toThrow();
	} finally {
		await agent?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
