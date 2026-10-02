/**
 * Scheduler Extension
 *
 * Schedule a prompt to fire later in a running pi session — "start in 3 hours".
 *
 * When the time arrives, the stored prompt is delivered to the agent exactly as
 * if you had just typed it, kicking off a turn. Tasks are persisted to
 * `~/.pi/agent/scheduled-tasks.json` and bound to the session that created them,
 * so a `/resume` of that session re-arms anything still pending (and runs
 * anything that came due while pi was closed).
 *
 * Commands:
 *   /schedule <when> <prompt>   Schedule a prompt. <when> is a duration
 *                               (30s, 15m, 3h, 1h30m, 2d), a clock time (14:30),
 *                               an ISO datetime, or @<epoch>.
 *   /schedule                   List / cancel pending tasks (no args).
 *   /schedules                  List / cancel pending tasks.
 *   /loop <interval> <prompt>   Run a prompt now, then repeat it every <interval>
 *                               until cancelled or its stated stop condition is met.
 *   /stop-loop [id]             Stop one loop, or all loops when id is omitted.
 *
 * Tools (LLM-callable): schedule_task, list_scheduled_tasks, cancel_scheduled_task
 *   Registered with deferred exposure: the model loads them through tool_search,
 *   prompted by a one-line <scheduler> system prompt section.
 *
 * Caveats:
 *   - Timers live in the pi process. Delivery happens only while a bound session
 *     is open. Closing pi pauses tasks; reopening that session re-arms them.
 *   - Only meaningful in interactive (TUI) or RPC mode, not print mode (-p).
 */

import * as os from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSessionScheduler, formatDuration as fmtDuration } from "./service.cjs";

interface Task {
	id: string;
	prompt: string;
	fireAt: number; // epoch ms
	createdAt: number;
	sessionFile: string | null; // origin session; null = ephemeral (memory only)
	cwd: string;
	// Repeating tasks carry the cadence in ms; on fire they re-arm the next
	// iteration this far in the future. Absent/undefined = one-shot.
	intervalMs?: number;
}

const WIDGET_KEY = "scheduler";
const NAMESPACE = {
	name: "scheduler",
	description: "Schedule, list and cancel delayed or repeating prompts (reminders, loops) in this session",
};

export default function (pi: ExtensionAPI) {
	// Per-session runtime state. `active` is rebound on every session_start and
	// cleared on session_shutdown so timers never fire through a stale context.
	let active: { ctx: ExtensionContext; sessionFile: string | null } | null = null;
	let tasks: Task[] = []; // pending tasks owned by the current session
	const { loadStore, disarmAll, arm, scheduleTask, scheduleLoop, cancel } = createSessionScheduler<Task>({
		getActive: () => active,
		getTasks: () => tasks,
		setTasks: (next) => {
			tasks = next;
		},
		storePath: () => join(os.homedir(), CONFIG_DIR_NAME, "agent", "scheduled-tasks.json"),
		updateWidget,
		preview,
		sendUserMessage: (prompt, options) => pi.sendUserMessage(prompt, options),
	});

	function updateWidget() {
		const ctx = active?.ctx;
		if (!ctx?.hasUI) return;
		if (tasks.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, []);
			return;
		}
		const next = [...tasks].sort((a, b) => a.fireAt - b.fireAt)[0];
		const inMs = next.fireAt - Date.now();
		const when = inMs > 0 ? `in ${fmtDuration(inMs)}` : "now";
		const kind = next.intervalMs ? `↺ every ${fmtDuration(next.intervalMs)}` : "next";
		ctx.ui.setWidget(WIDGET_KEY, [
			`⏰ scheduler: ${tasks.length} pending`,
			`  ${kind} ${when} (${new Date(next.fireAt).toLocaleTimeString()}): ${preview(next.prompt)}`,
		]);
	}

	// Interactive list + cancel flow, shared by /schedule (no args) and /schedules.
	async function listManage(ctx: ExtensionContext) {
		if (tasks.length === 0) {
			ctx.ui.notify("No scheduled tasks", "info");
			return;
		}
		const sorted = [...tasks].sort((a, b) => a.fireAt - b.fireAt);
		const items = sorted.map((t) => {
			const inMs = t.fireAt - Date.now();
			const when = inMs > 0 ? `in ${fmtDuration(inMs)}` : "due";
			const loop = t.intervalMs ? `↺${fmtDuration(t.intervalMs)} ` : "";
			return `${loop}${new Date(t.fireAt).toLocaleString()} (${when}) — ${preview(t.prompt)}`;
		});
		const choice = await ctx.ui.select("Scheduled tasks (select to cancel)", items);
		if (!choice) return;
		const picked = sorted[items.indexOf(choice)];
		if (!picked) return;
		const ok = await ctx.ui.confirm("Cancel task?", `${preview(picked.prompt, 120)}`);
		if (ok) {
			cancel(picked.id);
			ctx.ui.notify("Task cancelled", "info");
		}
	}

	// ---- lifecycle ---------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		active = { ctx, sessionFile: ctx.sessionManager.getSessionFile() ?? null };
		disarmAll();
		tasks = active.sessionFile ? loadStore().filter((t) => t.sessionFile === active?.sessionFile) : [];
		for (const t of tasks) arm(t);
		updateWidget();
		if (ctx.hasUI && tasks.length > 0) {
			ctx.ui.notify(`⏰ ${tasks.length} scheduled task(s) re-armed`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		disarmAll();
		active = null;
	});

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.scheduler =
			"Reminders and delayed or repeating work use the scheduler tools (schedule_task, list_scheduled_tasks, cancel_scheduled_task). " +
			"They are not loaded upfront: load them with tool_search before calling them.";
	});

	// ---- commands ----------------------------------------------------------

	pi.registerCommand("schedule", {
		description: "Schedule a prompt for later: /schedule <when> <prompt>",
		getArgumentCompletions: (prefix) => {
			const presets = ["5m", "15m", "30m", "1h", "2h", "3h", "tomorrow-09:00"];
			const items = presets.filter((p) => p.startsWith(prefix)).map((p) => ({ value: p, label: p }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await listManage(ctx);
				return;
			}
			const sep = trimmed.search(/\s/);
			if (sep === -1) {
				ctx.ui.notify('Usage: /schedule <when> <prompt>  (e.g. "/schedule 3h review issues")', "error");
				return;
			}
			const spec = trimmed.slice(0, sep);
			const prompt = trimmed.slice(sep + 1);
			try {
				const task = scheduleTask(spec, prompt, ctx);
				ctx.ui.notify(
					`⏰ Scheduled in ${fmtDuration(task.fireAt - Date.now())} — fires ${new Date(task.fireAt).toLocaleString()}`,
					"info"
				);
			} catch (e) {
				ctx.ui.notify(`Could not schedule: ${(e as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("schedules", {
		description: "List and cancel scheduled tasks",
		handler: async (_args, ctx) => {
			await listManage(ctx);
		},
	});

	pi.registerCommand("loop", {
		description: "Run a prompt now, then repeat every interval: /loop <interval> <prompt>",
		getArgumentCompletions: (prefix) => {
			const presets = ["30s", "1m", "5m", "15m", "30m", "1h", "2h"];
			const items = presets.filter((p) => p.startsWith(prefix)).map((p) => ({ value: p, label: p }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await listManage(ctx);
				return;
			}
			const sep = trimmed.search(/\s/);
			if (sep === -1) {
				ctx.ui.notify('Usage: /loop <interval> <prompt>  (e.g. "/loop 5m run the tests and report failures")', "error");
				return;
			}
			const interval = trimmed.slice(0, sep);
			const prompt = trimmed.slice(sep + 1);
			try {
				const task = scheduleLoop(interval, prompt, ctx);
				const every = fmtDuration(task.intervalMs ?? 0);
				ctx.ui.notify(`↺ Looping every ${every} — running the first iteration now. Cancel via /schedules.`, "info");
			} catch (e) {
				ctx.ui.notify(`Could not start loop: ${(e as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("stop-loop", {
		description: "Stop a repeating loop: /stop-loop [id] (no id stops all loops)",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (id) {
				const task = tasks.find((t) => t.id === id && t.intervalMs);
				if (!task) {
					ctx.ui.notify(`Loop not found: ${id}`, "error");
					return;
				}
				cancel(id);
				ctx.ui.notify(`Stopped loop ${id}`, "info");
				return;
			}
			const loops = tasks.filter((t) => t.intervalMs);
			for (const task of loops) cancel(task.id);
			ctx.ui.notify(loops.length > 0 ? `Stopped ${loops.length} loop(s)` : "No active loops", "info");
		},
	});

	// ---- tools -------------------------------------------------------------

	pi.registerTool({
		name: "schedule_task",
		label: "Schedule Task",
		exposure: "deferred",
		namespace: NAMESPACE,
		description:
			"Schedule a prompt to be delivered to yourself later in this session. " +
			"When it fires, the prompt is sent as a new user turn. Use for reminders or " +
			'deferred work ("in 3 hours, review X"). The session must stay open (or be ' +
			"resumed) at the scheduled time for delivery.",
		promptSnippet: "Schedule a prompt to run later (durations like 3h, or clock time 14:30)",
		promptGuidelines: ["Use schedule_task when the user asks to start or be reminded of work at a later time."],
		parameters: Type.Object({
			when: Type.String({
				description: "Delay (30s, 15m, 3h, 1h30m, 2d), clock time (14:30), ISO datetime, or @<epochMs>",
			}),
			prompt: Type.String({ description: "The prompt to deliver when the timer fires" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = scheduleTask(params.when, params.prompt, ctx);
			const inText = fmtDuration(task.fireAt - Date.now());
			return {
				content: [
					{
						type: "text",
						text: `Scheduled task ${task.id} in ${inText} (fires ${new Date(task.fireAt).toISOString()}).`,
					},
				],
				details: { id: task.id, fireAt: task.fireAt },
			};
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_task",
		label: "Cancel Scheduled Task",
		exposure: "deferred",
		namespace: NAMESPACE,
		description:
			"Cancel a pending scheduled task or loop by id. Loop iterations should call this when their explicit stop condition is satisfied.",
		promptSnippet: "Cancel a scheduled task or repeating loop by id",
		promptGuidelines: ["Use cancel_scheduled_task when a repeating loop's explicit stop condition has been satisfied."],
		parameters: Type.Object({
			id: Type.String({ description: "Task or loop id returned by the scheduler" }),
		}),
		async execute(_toolCallId, params) {
			const removed = cancel(params.id);
			if (!removed) throw new Error(`Scheduled task not found: ${params.id}`);
			return {
				content: [{ type: "text", text: `Cancelled ${removed.intervalMs ? "loop" : "task"} ${removed.id}.` }],
				details: { id: removed.id, cancelled: true, wasLoop: Boolean(removed.intervalMs) },
			};
		},
	});

	pi.registerTool({
		name: "list_scheduled_tasks",
		label: "List Scheduled Tasks",
		exposure: "deferred",
		namespace: NAMESPACE,
		description: "List pending scheduled tasks for the current session.",
		parameters: Type.Object({}),
		async execute() {
			if (tasks.length === 0) {
				return { content: [{ type: "text", text: "No scheduled tasks." }], details: { tasks: [] } };
			}
			const sorted = [...tasks].sort((a, b) => a.fireAt - b.fireAt);
			const lines = sorted.map(
				(t) =>
					`- ${t.id}: fires ${new Date(t.fireAt).toISOString()} (in ${fmtDuration(t.fireAt - Date.now())}) — ${preview(t.prompt, 80)}`
			);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { tasks: sorted },
			};
		},
	});
}

// ---- helpers ---------------------------------------------------------------

function preview(text: string, max = 48): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
