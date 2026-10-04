import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function archiveAttachments(workingDir: string, chatGuid: string, paths: string[]) {
	const directory = join(workingDir, "attachments", encodeURIComponent(chatGuid));
	await mkdir(directory, { recursive: true });
	const result: string[] = [];
	for (const source of paths) {
		const hash = createHash("sha256")
			.update(await readFile(source))
			.digest("hex");
		const extension = extname(source).toLowerCase();
		const heic = [".heic", ".heif"].includes(extension);
		const destination = join(directory, hash + (heic ? ".jpg" : extension));
		try {
			await access(destination);
		} catch {
			const temporary = `${destination}.${randomUUID()}`;
			try {
				if (heic) await execute("/usr/bin/sips", ["-s", "format", "jpeg", source, "--out", temporary]);
				else await copyFile(source, temporary);
				await rename(temporary, destination);
			} finally {
				await rm(temporary, { force: true });
			}
		}
		result.push(destination);
	}
	return result;
}
