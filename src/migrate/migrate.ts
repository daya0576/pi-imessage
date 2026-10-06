import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	access,
	copyFile,
	cp,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import { type AgentDefaults, chatConversation, WatchCursor } from "../agent/chats.ts";
import { openHarness } from "../agent/harness.ts";
import { openModels, readDefaults } from "../agent/models.ts";
import { Deliveries } from "../agent/replies.ts";

async function fileHash(path: string) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path)) hash.update(bytes);
	return hash.digest("hex");
}

async function manifest(root: string) {
	const result: Record<string, string> = {};
	async function walk(directory: string) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (directory === root && entry.name === "backup-manifest.json") continue;
			const path = join(directory, entry.name);
			// Old releases contain symlinks; they are copied as links, never followed.
			if (entry.isSymbolicLink()) result[relative(root, path)] = `link:${await readlink(path)}`;
			else if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) result[relative(root, path)] = await fileHash(path);
		}
	}
	await walk(root);
	return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
// Node's forced clone returns ENOSYS on macOS; the best-effort flag silently makes full copies.
const copyOptions = {
	recursive: true,
	force: false,
	errorOnExist: true,
	verbatimSymlinks: true,
	mode: constants.COPYFILE_FICLONE,
};
async function copyTree(source: string, target: string) {
	if (process.platform === "darwin") {
		// System cp uses APFS clones and preserves symlinks without following them.
		await promisify(execFile)("/bin/cp", ["-cRPn", source, target]);
	} else {
		await cp(source, target, copyOptions);
	}
}

function within(root: string, path: string) {
	const part = relative(root, path);
	return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part));
}

/** Offline, non-destructive import. The old service must be stopped by the operator before calling this. */
export async function migrate(options: {
	source: string;
	target: string;
	backup: string;
	cursor: number;
	defaults: AgentDefaults;
	archiveExternalAttachments?: boolean;
	allowMissingAttachments?: boolean;
	/** Import an operator-verified, already frozen backup instead of creating another copy. */
	reuseBackup?: boolean;
}) {
	const sourcePath = resolve(options.source);
	const source = await realpath(sourcePath);
	const target = join(await realpath(dirname(resolve(options.target))), basename(options.target));
	const backup = join(await realpath(dirname(resolve(options.backup))), basename(options.backup));
	if (source === parse(source).root || !Number.isSafeInteger(options.cursor) || options.cursor < 0)
		throw new Error("A scoped workspace and non-negative integer cursor are required");
	for (const [left, right] of [
		[source, target],
		[source, backup],
		[target, backup],
	])
		if (within(left, right) || within(right, left))
			throw new Error("Source, target and backup must be separate, non-nested directories");
	if (
		await access(target).then(
			() => true,
			(error) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		)
	)
		throw new Error("Target already exists; import runs only once into a new directory");
	if (
		(await readdir(source)).some((name) =>
			["backup-manifest.json", "durable", "imported-external-attachments"].includes(name),
		)
	)
		throw new Error("Source already contains migration/Durable data");
	const before = await manifest(options.reuseBackup ? backup : source);
	if (!options.reuseBackup) {
		await mkdir(backup, { mode: 0o700 });
		for (const entry of await readdir(source)) await copyTree(join(source, entry), join(backup, entry));
		if (
			JSON.stringify(await manifest(backup)) !== JSON.stringify(before) ||
			JSON.stringify(await manifest(source)) !== JSON.stringify(before)
		)
			throw new Error("Backup verification failed or source changed; no import performed");
	}
	await writeFile(
		join(backup, "backup-manifest.json"),
		JSON.stringify({ source, cursor: options.cursor, files: before }, null, 2),
	);
	const stage = join(dirname(target), `.imessage-import-${randomUUID()}`);
	let owner: Awaited<ReturnType<typeof openHarness>> | undefined;
	let messages = 0;
	let chats = 0;
	const archivedAttachments: Record<string, { file: string; sha256: string }> = {};
	const missingAttachments = new Set<string>();
	try {
		await mkdir(stage, { mode: 0o700 });
		// Keep old backup trees only in the verified backup, not in the new workspace.
		for (const entry of await readdir(backup)) {
			if (entry !== "backups") await copyTree(join(backup, entry), join(stage, entry));
		}
		owner = await openHarness(stage, createModels(), [], {});
		for (const entry of await readdir(backup, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const log = join(backup, entry.name, "log.jsonl");
			let lines: string;
			try {
				lines = await readFile(log, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			const conversation = await chatConversation(owner.harness, options.defaults, entry.name);
			let index = 0;
			for (const line of lines.split("\n")) {
				if (!line.trim()) continue;
				index++;
				const row = JSON.parse(line) as {
					date: string;
					text: string | null;
					attachments: string[];
					fromAgent: boolean;
					sender: string;
				};
				const timestamp = Date.parse(row.date);
				if (
					!Number.isFinite(timestamp) ||
					!(typeof row.text === "string" || row.text === null) ||
					!Array.isArray(row.attachments) ||
					typeof row.fromAgent !== "boolean"
				)
					throw new Error(`Invalid legacy message: ${entry.name}:${index}`);
				const paths: string[] = [];
				const missing: string[] = [];
				for (const attachment of row.attachments) {
					if (typeof attachment !== "string") throw new Error("Invalid attachment path");
					const requested = isAbsolute(attachment) ? attachment : resolve(source, attachment);
					const path = within(sourcePath, requested)
						? resolve(source, relative(sourcePath, requested))
						: requested;
					let resolved: string;
					try {
						resolved = await realpath(path);
					} catch (error) {
						if (!options.allowMissingAttachments || (error as NodeJS.ErrnoException).code !== "ENOENT")
							throw error;
						missing.push(attachment);
						missingAttachments.add(attachment);
						continue;
					}
					const name = `${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}-${basename(resolved)}`;
					let archived = join(backup, relative(source, resolved));
					if (!within(source, resolved)) {
						if (!options.archiveExternalAttachments)
							throw new Error(`Archive external attachment before import: ${path}`);
						const file = join("imported-external-attachments", name);
						archived = join(backup, file);
						if (!archivedAttachments[resolved]) {
							const sha256 = await fileHash(resolved);
							await mkdir(dirname(archived), { recursive: true });
							await copyFile(resolved, archived, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
							if ((await fileHash(archived)) !== sha256 || (await fileHash(resolved)) !== sha256)
								throw new Error("External attachment changed during backup");
							archivedAttachments[resolved] = { file, sha256 };
						}
					}
					const directory = join(stage, "attachments", encodeURIComponent(entry.name));
					await mkdir(directory, { recursive: true });
					await copyFile(archived, join(directory, name), constants.COPYFILE_FICLONE);
					paths.push(join(target, "attachments", encodeURIComponent(entry.name), name));
				}
				const content = [
					row.text ?? "",
					...paths.map((path) => `[Attachment: ${path}]`),
					...missing.map((path) => `[Missing attachment: ${path}]`),
				]
					.filter(Boolean)
					.join("\n");
				const model: UserMessage | AssistantMessage = row.fromAgent
					? {
							role: "assistant",
							content: [{ type: "text", text: content }],
							api: "legacy",
							provider: "legacy",
							model: "unknown",
							timestamp,
							stopReason: "stop",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						}
					: { role: "user", content, timestamp };
				await conversation.submit(
					{
						type: "write",
						requestId: `import:${index}`,
						entry: {
							kind: row.fromAgent ? AssistantEntry.kind : UserEntry.kind,
							data: { legacy: true, original: JSON.parse(line), missingAttachments: missing },
							model: [model],
						},
					},
					BACKGROUND_CONTEXT,
				);
				messages++;
			}
			await conversation.reset(undefined, BACKGROUND_CONTEXT);
			const reset = (await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0];
			if (!reset) throw new Error("Import reset missing");
			await owner.harness.commit(async (tx) => {
				(await tx.doc(Deliveries, conversation.id)).scanned = reset.id;
			}, BACKGROUND_CONTEXT);
			chats++;
		}
		await owner.harness.commit(async (tx) => {
			(await tx.doc(WatchCursor)).rowid = options.cursor;
		}, BACKGROUND_CONTEXT);
		await owner.close();
		owner = undefined;
		const backupManifest = JSON.stringify(
			{
				source,
				cursor: options.cursor,
				files: {
					...before,
					...Object.fromEntries(Object.values(archivedAttachments).map(({ file, sha256 }) => [file, sha256])),
				},
				archivedAttachments,
				missingAttachments: [...missingAttachments],
				reusedBackup: options.reuseBackup ?? false,
			},
			null,
			2,
		);
		await writeFile(join(backup, "backup-manifest.json"), backupManifest);
		await writeFile(join(stage, "backup-manifest.json"), backupManifest);
		await writeFile(
			join(stage, "import-receipt.json"),
			JSON.stringify(
				{
					source,
					backup,
					cursor: options.cursor,
					messages,
					chats,
					archivedAttachments,
					missingAttachments: [...missingAttachments],
					reusedBackup: options.reuseBackup ?? false,
					excludedWorkspaceDirectories: ["backups"],
					completedAt: new Date().toISOString(),
				},
				null,
				2,
			),
		);
		await rename(stage, target);
		return { messages, chats, backup, target };
	} catch (error) {
		await owner?.close().catch(() => {});
		await rm(stage, { recursive: true, force: true });
		throw error;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	void (async () => {
		const values: Record<string, string> = {};
		const args = process.argv.slice(2);
		for (let index = 0; index < args.length; index++) {
			if (["--archive-external-attachments", "--allow-missing-attachments"].includes(args[index])) {
				values[args[index].slice(2)] = "true";
				continue;
			}
			if (!["--source", "--target", "--backup", "--cursor"].includes(args[index]) || !args[index + 1])
				throw new Error("Invalid import arguments");
			values[args[index].slice(2)] = args[index + 1];
			index++;
		}
		if (!["source", "target", "backup", "cursor"].every((key) => values[key]))
			throw new Error("Source, target, backup and cursor are required");
		const agentDir = getAgentDir();
		const models = await openModels(agentDir);
		console.log(
			JSON.stringify(
				await migrate({
					source: values.source,
					target: values.target,
					backup: values.backup,
					cursor: Number(values.cursor),
					defaults: await readDefaults(models, values.source, agentDir),
					archiveExternalAttachments: values["archive-external-attachments"] === "true",
					allowMissingAttachments: values["allow-missing-attachments"] === "true",
				}),
			),
		);
	})().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
