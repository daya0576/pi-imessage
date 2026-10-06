import type * as FileSystem from "node:fs/promises";
import type * as Paths from "node:path";
import type { defineExtension as DefineExtension, section as Section } from "@earendil-works/pi-durable";

const { constants, open } = require("node:fs/promises") as typeof FileSystem;
const { resolve } = require("node:path") as typeof Paths;
/** Per-file byte budget for System summary; dated history is never loaded here. */

async function readSummary(path: string, maxBytes: number, boundary: string) {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		if (!(await file.stat()).isFile())
			return "[System summary unavailable: expected a regular summary file.]";
		const buffer = Buffer.alloc(maxBytes + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (!result.bytesRead) break;
			bytesRead += result.bytesRead;
		}
		const truncated = bytesRead > maxBytes;
		// A streaming decode drops only an incomplete trailing UTF-8 character at the byte boundary.
		const text = new TextDecoder("utf-8", { fatal: true })
			.decode(buffer.subarray(0, Math.min(bytesRead, maxBytes)), { stream: truncated })
			.trim();
		const end = boundary ? text.indexOf(boundary) : -1;
		if (end >= 0) return text.slice(0, end).trim();
		return truncated
			? `${text}\n\n[System summary exceeded the ${maxBytes}-byte summary limit; the rest was not loaded. Read the full file on demand.]`
			: text;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		return "[System summary summary unavailable.]";
	} finally {
		await file?.close();
	}
}

module.exports = async ({
	workingDir,
	config,
	defineExtension,
	section,
}: {
	workingDir: string;
	config: Record<string, unknown>;
	defineExtension: typeof DefineExtension;
	section: typeof Section;
}) => {
	if (
		typeof config.summaryFile !== "string" ||
		!config.summaryFile ||
		!Number.isSafeInteger(config.maxBytes) ||
		(config.maxBytes as number) <= 0 ||
		(config.maxBytes as number) > 65536 ||
		typeof config.boundary !== "string"
	)
		throw new Error("System context requires summaryFile, maxBytes (1..65536) and boundary");
	const summary = await readSummary(
		resolve(workingDir, config.summaryFile),
		config.maxBytes as number,
		config.boundary,
	);
	return defineExtension({
		name: "system-context",
		sections: [section("system_configuration", () => summary || undefined)],
	});
};
