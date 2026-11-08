import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

/** Prompt tokens the `codemode` section may spend listing callable tools; the rest is found with `searchTools()`. */
const INLINE_BUDGET = 1200;

/**
 * Durable code mode: the model writes a script that calls the conversation's tools; only the script's output enters
 * the context. One sandbox per process; closing it while a script runs is not an outcome, the script resumes with the
 * next process's sandbox. `models.*` stays off: scripts must not start model calls.
 */
export function createCodemode() {
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
	return {
		extension: createCodemodeExtension({ sandbox, inlineBudget: INLINE_BUDGET, models: false }),
		close: () => sandbox.close(),
	};
}
