/**
 * File-based logger with size-based rotation.
 *
 * Two log destinations:
 *   app.log    — receives ALL console output (log / warn / error / info)
 *   diget.log  — receives only incoming/outgoing digest lines
 *
 * Rotation strategy:
 *   - Rotate when the active file reaches MAX_BYTES (default 10 MB)
 *   - Keep up to MAX_FILES rotated copies (default 5)
 *   - On rotation: .5 is deleted, .4→.5, …, .1→.2, active→.1, new active created
 */

import { createWriteStream, existsSync, renameSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_FILES = 5;

// ── Rotating file writer ──────────────────────────────────────────────────────

class RotatingFileWriter {
	private stream: WriteStream;
	private currentSize: number;

	constructor(
		private readonly filePath: string,
		private readonly maxBytes: number,
		private readonly maxFiles: number
	) {
		this.currentSize = existsSync(filePath) ? statSync(filePath).size : 0;
		this.stream = createWriteStream(filePath, { flags: "a" });
	}

	write(line: string): void {
		const byteLength = Buffer.byteLength(line, "utf8");
		if (this.currentSize + byteLength > this.maxBytes) {
			this.rotate();
		}
		this.stream.write(line);
		this.currentSize += byteLength;
	}

	private rotate(): void {
		this.stream.end();

		// Shift rotated files: .maxFiles deleted, …, .1 → .2, active → .1
		for (let index = this.maxFiles - 1; index >= 1; index--) {
			const from = `${this.filePath}.${index}`;
			const to = `${this.filePath}.${index + 1}`;
			if (existsSync(from)) renameSync(from, to);
		}
		if (existsSync(this.filePath)) {
			renameSync(this.filePath, `${this.filePath}.1`);
		}

		this.stream = createWriteStream(this.filePath, { flags: "a" });
		this.currentSize = 0;
	}

	close(): void {
		this.stream.end();
	}
}

// ── Timestamp helper ──────────────────────────────────────────────────────────

function timestamp(): string {
	return new Date().toISOString();
}

function formatLine(args: unknown[]): string {
	return `[${timestamp()}] ${args.map(String).join(" ")}\n`;
}

// ── App logger — patches console, writes everything to app.log ────────────────

export interface AppLogger {
	/** Restore original console methods and close the file stream. */
	close(): void;
}

export function createAppLogger(workingDir: string, options: { maxBytes?: number; maxFiles?: number } = {}): AppLogger {
	const writer = new RotatingFileWriter(
		join(workingDir, "app.log"),
		options.maxBytes ?? DEFAULT_MAX_BYTES,
		options.maxFiles ?? DEFAULT_MAX_FILES
	);

	const originalLog = console.log.bind(console);
	const originalWarn = console.warn.bind(console);
	const originalError = console.error.bind(console);
	const originalInfo = console.info.bind(console);

	function writeAndForward(original: (...args: unknown[]) => void, args: unknown[]): void {
		const line = formatLine(args);
		writer.write(line);
		original(line.trimEnd());
	}

	console.log = (...args: unknown[]) => writeAndForward(originalLog, args);
	console.warn = (...args: unknown[]) => writeAndForward(originalWarn, args);
	console.error = (...args: unknown[]) => writeAndForward(originalError, args);
	console.info = (...args: unknown[]) => writeAndForward(originalInfo, args);

	return {
		close() {
			console.log = originalLog;
			console.warn = originalWarn;
			console.error = originalError;
			console.info = originalInfo;
			writer.close();
		},
	};
}

// ── Digest logger — writes incoming/outgoing lines to diget.log ───────────────

export interface DigestLogger {
	/**
	 * Write a digest line to diget.log and forward to console.log
	 * (which in turn lands in app.log via the app logger patch).
	 */
	log(msg: string): void;
	close(): void;
}

export function createDigestLogger(
	workingDir: string,
	options: { maxBytes?: number; maxFiles?: number } = {}
): DigestLogger {
	const writer = new RotatingFileWriter(
		join(workingDir, "diget.log"),
		options.maxBytes ?? DEFAULT_MAX_BYTES,
		options.maxFiles ?? DEFAULT_MAX_FILES
	);

	return {
		log(msg: string) {
			writer.write(formatLine([msg]));
			// Forward to console.log so the line also appears in app.log
			// (and on stdout for live monitoring).
			console.log(msg);
		},
		close() {
			writer.close();
		},
	};
}
