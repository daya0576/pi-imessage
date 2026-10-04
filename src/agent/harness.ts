import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, type Extension, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export async function openHarness(workingDir: string, models: Models, extensions: readonly Extension[]) {
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
			for (const extension of extensions) registry.install(extension);
			const env = new NodeExecutionEnv({ cwd: workingDir });
			const harness = await Harness.open(
				storage,
				// Large Codex contexts exceed WebSocket frame limits; force SSE.
				{ models, registry, env: () => env, settings: { stream: { transport: "sse" } } },
				BACKGROUND_CONTEXT,
			);
			let closing: Promise<void> | undefined;
			return {
				harness,
				storage,
				close() {
					closing ??= (async () => {
						await harness.close(BACKGROUND_CONTEXT);
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
