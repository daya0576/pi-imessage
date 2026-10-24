import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineDoc,
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
						await abortRepeatedlyInterruptedTools(harness);
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

/** Tool tasks that were running at the last ordinary stop; each is rerun once (#39). */
const StopInterruptions = defineDoc<{ tasks: number[] }>({
	kind: "imessage.stop-interruptions",
	version: 1,
	scope: "session",
	initial: () => ({ tasks: [] }),
	checkpointWhen: () => false,
});

/** How long an ordinary stop waits for aborted tools to settle before closing anyway. */
const ABORT_SETTLE_MS = 5_000;

/**
 * #39: a tool running at an ordinary stop is rerun at the next start, as ADR 0041 says. A tool task still running
 * at the following stop was already rerun once, so it is marked for abort instead; the mark is durable, and the model
 * gets the partial output. This ends a tool call that stops the service itself after one extra restart.
 */
async function abortRepeatedlyInterruptedTools(harness: Harness) {
	const running = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
		({ record, state }) => record.kind === ToolTask.definition.name && state.kind === "running",
	);
	const previous = (await harness.snapshot(StopInterruptions, BACKGROUND_CONTEXT))?.tasks ?? [];
	const repeated = running.filter(({ record }) => previous.includes(Number(record.id)));
	await harness.commit(async (tx) => {
		const interruptions = await tx.doc(StopInterruptions);
		interruptions.tasks = running
			.filter((task) => !repeated.includes(task))
			.map(({ record }) => Number(record.id));
	}, BACKGROUND_CONTEXT);
	if (repeated.length === 0) return;
	for (const { record } of repeated) {
		await harness.abortTask(record.id, BACKGROUND_CONTEXT);
		console.log(new Date().toISOString(), "Tool aborted by stop: interrupted twice in a row", {
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
			Promise.allSettled(repeated.map(({ record }) => harness.waitForTask(record.id, BACKGROUND_CONTEXT))),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
	}
}
