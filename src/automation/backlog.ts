import { existsSync, readFileSync, statSync } from "node:fs";
import type { AutomationView } from "./service.ts";

/** Display-only plans. Deliberately separate from executable job configuration. */
export function readTaskBacklog(path: string, executableIds: Set<string>): AutomationView[] {
	if (!existsSync(path)) return [];
	try {
		if (statSync(path).size > 128 * 1024) throw new Error();
		const input = JSON.parse(readFileSync(path, "utf8"));
		if (input?.version !== 1 || !Array.isArray(input.tasks) || input.tasks.length > 100) throw new Error();
		const ids = new Set<string>();
		return input.tasks.map((task: Record<string, unknown>) => {
			if (
				!task ||
				typeof task !== "object" ||
				Array.isArray(task) ||
				Object.keys(task).some((key) => !["id", "name", "summary", "frequency"].includes(key)) ||
				typeof task.id !== "string" ||
				!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(task.id) ||
				ids.has(task.id) ||
				executableIds.has(task.id) ||
				typeof task.name !== "string" ||
				!task.name.trim() ||
				task.name.length > 120 ||
				typeof task.summary !== "string" ||
				task.summary.length > 2000 ||
				typeof task.frequency !== "string" ||
				task.frequency.length > 120
			)
				throw new Error();
			ids.add(task.id);
			return {
				id: task.id,
				name: task.name,
				state: "planned",
				paused: 0,
				blocked: 0,
				lastSuccess: null,
				nextRun: null,
				reason: `${task.frequency} · ${task.summary}`,
				incident: 0,
				enabled: false,
				running: false,
				notification: "none",
			};
		});
	} catch {
		console.error("[automation] Invalid display-only task backlog; executable jobs are unchanged");
		return [];
	}
}
