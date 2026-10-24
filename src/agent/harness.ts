import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	createRegistry,
	type Extension,
	Harness,
	type HarnessSettings,
	ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { chatBehavior } from "./behavior.ts";
import { RunExtension } from "./run.ts";

export async function openHarness(
	workingDir: string,
	models: Models,
	extensions: readonly Extension[],
	policy: Pick<HarnessSettings, "stream" | "retry">,
) {
	const directory = join(workingDir, "durable");
	await mkdir(directory, { recursive: true });
	const lockPath = join(directory, "owner.lock");
	// Never steal a lock: after an unclean exit the operator must confirm its owner is dead.
	const lock = await open(lockPath, "wx");
	try {
		await lock.writeFile(`${process.pid}\n`);
		const storage = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, { fsync: true });
		try {
			const registry = createRegistry();
			registry.install(chatBehavior(storage));
			registry.install(RunExtension);
			for (const extension of extensions) {
				if (registry.snapshot().extension(extension.name))
					throw new Error(`Duplicate extension name: ${extension.name}`);
				registry.install(extension);
			}
			const env = new NodeExecutionEnv({ cwd: workingDir });
			const harness = await Harness.open(
				storage,
				// Large Codex contexts exceed WebSocket frame limits; force SSE.
				{
					models,
					registry,
					env: () => env,
					// Consume all admitted corrections at the next native boundary, not one per turn.
					settings: {
						get stream() {
							return { ...policy.stream, transport: "sse" as const };
						},
						get retry() {
							return policy.retry;
						},
						steeringMode: "all",
						// Only run conversations select the run extension; reread so reinstalls apply.
						get extensions() {
							return registry
								.snapshot()
								.installed()
								.filter((extension) => extension.name !== RunExtension.name);
						},
					},
				},
				BACKGROUND_CONTEXT,
			);
			let closing: Promise<void> | undefined;
			return {
				harness,
				storage,
				registry,
				close(beforeUnlock?: () => Promise<void>) {
					closing ??= (async () => {
						await abortRunningTools(harness);
						await harness.close(BACKGROUND_CONTEXT);
						// External browser resources must be closed before another owner can resume this workspace.
						await beforeUnlock?.();
						await lock.close();
						await unlink(lockPath);
					})();
					return closing;
				},
			};
		} catch (error) {
			await storage.close(BACKGROUND_CONTEXT);
			throw error;
		}
	} catch (error) {
		await lock.close();
		await unlink(lockPath);
		throw error;
	}
}

/** How long an ordinary stop waits for aborted tools to settle before closing anyway. */
const ABORT_SETTLE_MS = 5_000;

/**
 * ADR 0050: a tool running at an ordinary stop is marked for abort instead of being rerun at the next start. The mark
 * is durable, so a task the close still interrupts is aborted on recovery; the model gets its partial output.
 */
async function abortRunningTools(harness: Harness) {
	const running = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
		({ record, state }) => record.kind === ToolTask.definition.name && state.kind === "running",
	);
	if (running.length === 0) return;
	for (const { record } of running) {
		await harness.abortTask(record.id, BACKGROUND_CONTEXT);
		console.log(new Date().toISOString(), "Tool aborted by stop", {
			task: record.id,
			conversation: record.conversationId,
		});
	}
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ABORT_SETTLE_MS);
	});
	try {
		await Promise.race([
			Promise.allSettled(running.map(({ record }) => harness.waitForTask(record.id, BACKGROUND_CONTEXT))),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
	}
}
