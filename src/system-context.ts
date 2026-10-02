import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/** Per-document byte budget, not a character/token estimate. Historical files are never loaded here. */
export const SYSTEM_CONTEXT_MAX_BYTES = 8192;
export const SYSTEM_SUMMARY_END = "<!-- END SYSTEM SUMMARY -->";

export function readSystemSummary(directory: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(join(directory, "SYSTEM.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) return "[SYSTEM.md unavailable: expected a regular summary file.]";
		const buffer = Buffer.alloc(SYSTEM_CONTEXT_MAX_BYTES + 1);
		let count = 0;
		while (count < buffer.length) {
			const bytes = readSync(fd, buffer, count, buffer.length - count, count);
			if (!bytes) break;
			count += bytes;
		}
		const truncated = count > SYSTEM_CONTEXT_MAX_BYTES;
		// A streaming decode drops only an incomplete trailing UTF-8 character at the byte boundary.
		const text = new TextDecoder("utf-8", { fatal: true })
			.decode(buffer.subarray(0, Math.min(count, SYSTEM_CONTEXT_MAX_BYTES)), {
				stream: truncated,
			})
			.trim();
		const end = text.indexOf(SYSTEM_SUMMARY_END);
		if (end >= 0) return text.slice(0, end).trim();
		return truncated
			? `${text}\n\n[SYSTEM.md exceeded the 8192-byte summary limit; remaining content was not loaded. Read relevant files explicitly if needed. Keep only current configuration here; detailed change history belongs in system-history/YYYY-MM-DD.md.]`
			: text;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		return "[SYSTEM.md summary unavailable; no historical file was loaded as fallback.]";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function readSystemContext(workingDir: string, chatDir?: string): string {
	const parts: string[] = [];
	const global = readSystemSummary(workingDir);
	if (global) parts.push(`## Current system configuration\n${global}`);
	if (chatDir && chatDir !== workingDir) {
		const chat = readSystemSummary(chatDir);
		if (chat) parts.push(`## Chat-scoped system configuration\n${chat}`);
	}
	return parts.join("\n\n");
}
