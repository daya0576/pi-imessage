import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export type ActivityTimeoutKind = "idle" | "max_duration";
export class AgentPromptTimeoutError extends Error {
	constructor(
		readonly kind: ActivityTimeoutKind,
		readonly timeoutMs: number
	) {
		super(
			kind === "idle"
				? `operation idle timed out after ${timeoutMs}ms`
				: `operation exceeded maximum duration of ${timeoutMs}ms`
		);
		this.name = "AgentPromptTimeoutError";
	}
}
export function saveInterruption(sessionDir: string, error: AgentPromptTimeoutError, pendingTools: string[]): void {
	mkdirSync(sessionDir, { recursive: true });
	const target = join(sessionDir, "interrupted-prompt.json");
	const temp = `${target}.${process.pid}.tmp`;
	writeFileSync(
		temp,
		`${JSON.stringify({ version: 1, at: new Date().toISOString(), reason: error.kind, timeoutMs: error.timeoutMs, pendingTools, toolOutcomesMayBeUnknown: pendingTools.length > 0, autoReplay: false, transcript: "context.jsonl" }, null, 2)}\n`,
		{ mode: 0o600 }
	);
	renameSync(temp, target);
}
