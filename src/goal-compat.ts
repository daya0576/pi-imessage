import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface ImportedGoal {
	id: string;
	objective: string;
	status: "paused" | "blocked";
	autoContinue: false;
	sisyphus: false;
	usage: { tokensUsed: number; activeSeconds: number };
	createdAt: string;
	updatedAt: string;
	stopReason: "agent";
	pauseReason: string;
}

/** Read-only legacy conversion; the installed extension owns all new-format writes. */
export function importLegacyGoal(sessionDir: string, persist: (goal: ImportedGoal) => void): void {
	const path = join(sessionDir, "goal.json");
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return;
	if (!stat.isFile() || stat.size > 64_000) throw new Error("Unsafe legacy goal file; migration refused");
	const record: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
	const text = (key: string, maximum: number) => typeof record[key] === "string" && record[key].length <= maximum;
	if (
		record.version !== 1 ||
		!text("chatGuid", 240) ||
		record.chatGuid !== sessionDir.split(/[\\/]/).at(-1) ||
		!text("generation", 36) ||
		!/^[a-f0-9-]{36}$/.test(String(record.generation)) ||
		!text("objective", 2000) ||
		!["ready", "running", "paused", "blocked", "completed", "cleared"].includes(String(record.state)) ||
		!["progress", "reason", "evidence"].every((key) => text(key, 4000)) ||
		record.limit !== 4 ||
		!Number.isInteger(record.turns) ||
		Number(record.turns) < 0 ||
		Number(record.turns) > 4
	)
		throw new Error("Invalid legacy goal; migration refused without changing its checkpoint");
	if (record.state === "cleared" || !String(record.objective).trim()) return;
	const id = `legacy-${createHash("sha256").update(String(record.generation)).digest("hex").slice(0, 24)}`;
	const metadata = join(sessionDir, "goals", ".metadata");
	for (const directory of [sessionDir, join(sessionDir, "goals"), metadata]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (!lstatSync(directory).isDirectory()) throw new Error("Unsafe legacy goal migration directory");
	}
	const marker = join(metadata, `${id}.imported.json`);
	const marked = lstatSync(marker, { throwIfNoEntry: false });
	if (marked) {
		if (!marked.isFile() || JSON.parse(readFileSync(marker, "utf8")).id !== id)
			throw new Error("Invalid legacy goal migration receipt");
		return;
	}
	const timestamp = stat.mtime.toISOString();
	persist({
		id,
		objective: String(record.objective),
		status: record.state === "blocked" ? "blocked" : "paused",
		autoContinue: false,
		sisyphus: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		createdAt: timestamp,
		updatedAt: timestamp,
		stopReason: "agent",
		pauseReason: [
			`Imported legacy state=${record.state}; turns=${record.turns}/${record.limit}. No operations replayed. Explicit /goal resume is required; verify unknown results first.`,
			`Progress: ${record.progress}`,
			`Reason: ${record.reason}`,
			`Reported evidence (not independent proof): ${record.evidence}`,
		].join("\n"),
	});
	// Written only after the canonical goal writer succeeds. Never reimport a later archived goal.
	writeFileSync(marker, `${JSON.stringify({ id })}\n`, { mode: 0o600, flag: "wx" });
	console.log(`[goal] legacy checkpoint imported paused without replay: ${id}`);
}

/** Only exact user slash commands are translated, never ordinary prose or model output. */
export function goalCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/goal(?:\s+(.*))?$/s.exec(text.trim());
	if (match) {
		const argument = match[1]?.trim() || "status";
		if (["status", "pause", "resume", "clear", "list", "focus", "unfocus"].includes(argument))
			return { name: `goal-${argument}`, args: "" };
		return { name: "goal-direct", args: argument };
	}
	const native = /^\/(goal-(?:status|pause|resume|clear|list|focus|unfocus|direct))(?:\s+(.*))?$/s.exec(text.trim());
	return native ? { name: native[1], args: native[2]?.trim() ?? "" } : undefined;
}

/** Native handlers still own locking, state transitions, resume allowance and archives. */
export async function runGoalCommand(session: AgentSession, name: string, args: string): Promise<string | undefined> {
	const runner = session.extensionRunner;
	const command = runner?.getCommand?.(name);
	if (!command) return;
	const notifications: string[] = [];
	const context = runner.createCommandContext();
	await command.handler(args, {
		...context,
		// The exact user clear command is its confirmation, not a generic permission to approve dialogs.
		hasUI: name === "goal-clear",
		ui: {
			...context.ui,
			notify: (message) => {
				notifications.push(message);
			},
			confirm: async (title) => name === "goal-clear" && title === "Clear goal?",
		},
	});
	return notifications.join("\n") || "Goal command applied.";
}
