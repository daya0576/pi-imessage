/**
 * Simple digest logger — one-line-per-event log for observability.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function createLogger(logFile: string) {
	mkdirSync(dirname(logFile), { recursive: true });

	function log(level: string, message: string, meta?: Record<string, unknown>) {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			level,
			message,
			...meta,
		});
		appendFileSync(logFile, `${line}\n`);
	}

	return {
		info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
		error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
	};
}
