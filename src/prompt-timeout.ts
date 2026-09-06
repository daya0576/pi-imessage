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
export function timeoutNotice(error: AgentPromptTimeoutError, checkpointSaved: boolean): string {
	const reason =
		error.kind === "max_duration"
			? `本次执行达到 ${Math.round(error.timeoutMs / 60_000)} 分钟安全上限`
			: `本次执行连续 ${Math.round(error.timeoutMs / 1000)} 秒没有活动`;
	return `${reason}，已中止当前会话。${checkpointSaved ? "中断检查点已保存。" : "中断检查点保存失败，需检查日志。"}后台进程不一定停止；不会盲目重跑已执行的操作。已登记的后台任务仍会在完成后自动汇总，未登记的需要先核对状态再继续。`;
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
