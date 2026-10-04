import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Harness, Submission } from "@earendil-works/pi-durable";
import { Chats } from "../agent/chats.ts";
import type { DirectSendInput, DirectSendReceipt } from "../agent/direct-send.ts";
import { type PromptInput, Sessions } from "../agent/isolated.ts";
import { Runs } from "../agent/run.ts";
import { scheduleExtension } from "../extensions/schedule.ts";
import { createBackgroundService } from "./background.ts";
import { type CronService, createCronService } from "./cron.ts";
import { createReminderService, REMINDER_STATUSES, type ReminderStatus } from "./reminders.ts";
import { createSchedulerService, parseSchedulerInterval, parseSchedulerTime } from "./scheduler.ts";

const execute = promisify(execFile);
export async function createServices(options: {
	workingDir: string;
	agent: {
		harness: Harness;
		prompt(input: PromptInput): Promise<Submission>;
		result(submission: Submission): Promise<string>;
		sendDirect(input: DirectSendInput): Promise<DirectSendReceipt>;
	};
}) {
	const { agent, workingDir } = options;
	async function send(input: DirectSendInput) {
		const receipt = await agent.sendDirect(input);
		if (receipt.textStatus === "unknown" || receipt.fileStatus === "unknown")
			throw new Error("Send outcome unknown; will not repeat the effect");
	}
	const workers: { start(): void; stop(): Promise<void> }[] = [];
	try {
		let cron: CronService;
		const reminders = createReminderService({
			workingDir,
			deliver: (reminder) =>
				send({ chatGuid: reminder.chatGuid, requestId: `reminder:${reminder.id}`, text: reminder.text }),
		});
		workers.push(reminders);
		const scheduler = createSchedulerService({
			workingDir,
			deliver: async (task) => {
				await agent.prompt({
					chatGuid: task.owner,
					sessionKey: `scheduled-${task.id}`,
					scope: "cron",
					requestId: task.runId,
					prompt: task.text ?? task.prompt,
				});
			},
		});
		workers.push(scheduler);
		const background = createBackgroundService({
			workingDir,
			summarize: async (job) =>
				agent.result(
					await agent.prompt({
						chatGuid: job.chatGuid,
						sessionKey: `background-${job.id}`,
						scope: "background",
						requestId: `summary:${job.id}`,
						prompt: `Read completion file ${JSON.stringify(job.completionFile)} and the result files it names. ${job.instruction}`,
						readOnly: true,
						deliver: false,
					}),
				),
			deliver: (chatGuid, text, key) => {
				if (!key) throw new Error("Background delivery ID is required");
				return send({ chatGuid, text, requestId: `background:${key}` });
			},
		});
		workers.push(background);
		cron = createCronService({
			workingDir,
			execute: async (job, signal) => {
				const run = cron.listRuns(1000).find((run) => run.jobId === job.id && run.status === "running");
				if (!run) throw new Error("Cron run receipt missing");
				const action = job.action;
				if (action.type === "send")
					await send({ chatGuid: action.chatGuid, text: action.text, requestId: `cron:${run.id}` });
				else if (action.type === "exec") {
					if (!isAbsolute(action.argv[0])) throw new Error("Cron exec requires an absolute executable");
					const result = await execute(action.argv[0], action.argv.slice(1), {
						cwd: action.cwd ?? workingDir,
						signal,
						maxBuffer: 1024 * 1024,
					});
					if (result.stdout.trim()) console.log("Cron output", job.id, result.stdout.trim());
				} else {
					const submission = await agent.prompt({
						chatGuid: action.chatGuid,
						prompt: action.prompt,
						sessionKey: `cron-${createHash("sha256").update(job.id).digest("hex").slice(0, 32)}`,
						scope: "cron",
						requestId: `cron:${run.id}`,
					});
					try {
						const result = await submission.wait(withAbortSignal(signal, BACKGROUND_CONTEXT));
						if (result.status !== "done") throw new Error(`Cron prompt ended: ${result.reason}`);
					} catch (error) {
						if (signal.aborted) {
							const record = await submission.status(BACKGROUND_CONTEXT);
							await (await agent.harness.conversation(record.conversationId, BACKGROUND_CONTEXT))?.abort(
								BACKGROUND_CONTEXT,
							);
						}
						throw error;
					}
				}
			},
		});
		workers.push(cron);
		return {
			reminders,
			scheduler,
			background,
			cron,
			extension: scheduleExtension({
				async owner(id) {
					const chats = (await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items ?? [];
					const sessions = ((await agent.harness.snapshot(Sessions, BACKGROUND_CONTEXT))?.items ?? []).filter(
						(session) => !session.key.startsWith('["health",'),
					);
					const runs = (await agent.harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items ?? [];
					const owner = [...chats, ...sessions, ...runs].find((item) => item.conversationId === id)?.chatGuid;
					if (!owner) throw new Error("No destination chat for scheduler tools");
					return owner;
				},
				schedule: (owner, when, prompt, every, idempotencyKey) =>
					scheduler.schedule({
						owner,
						prompt,
						fireAt: parseSchedulerTime(when),
						intervalMs: every ? (parseSchedulerInterval(every) ?? undefined) : undefined,
						idempotencyKey,
					}),
				list: scheduler.list,
				cancel: (owner, id) => scheduler.cancel(id, owner),
				watch: (chatGuid, input) => background.create({ chatGuid, ...input }),
			}),
			api: {
				data: () => ({
					jobs: cron.list(),
					runs: cron.listRuns(100),
					reminders: reminders.list(),
					prompts: scheduler.list(),
					background: background.list(),
				}),
				listReminders: (status?: string) => {
					if (status && !REMINDER_STATUSES.includes(status as ReminderStatus))
						throw new Error("Invalid reminder status");
					return reminders.list(status as ReminderStatus | undefined);
				},
				createReminder: reminders.create,
				cancelReminder: reminders.cancel,
				runCron: cron.runNow,
				setCronEnabled: cron.setEnabled,
			},
			start() {
				for (const worker of workers) worker.start();
			},
			async close() {
				await Promise.all(workers.map((worker) => worker.stop()));
			},
		};
	} catch (error) {
		await Promise.allSettled(workers.map((worker) => worker.stop()));
		throw error;
	}
}
