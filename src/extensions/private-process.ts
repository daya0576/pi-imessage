import { execFile } from "node:child_process";

/** A request-bound owned subprocess. Neither secret stdout nor raw argv/errors are logged. */
export function privateProcess(
	file: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		timeoutMs?: number;
		classifyError?: (stderr: string, stdout: string) => string;
	},
) {
	options.signal?.throwIfAborted();
	return new Promise<string>((resolve, reject) => {
		let failure: NodeJS.ErrnoException | undefined;
		let escalation: NodeJS.Timeout | undefined;
		const child = execFile(
			file,
			args,
			{ cwd: options.cwd, env: options.env, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout, stderr) => {
				clearTimeout(deadline);
				clearTimeout(escalation);
				options.signal?.removeEventListener("abort", abort);
				if (failure || error) {
					const code = failure?.code ?? error?.code ?? "failed";
					const reason = !failure && error ? options.classifyError?.(stderr, stdout) : undefined;
					reject(
						Object.assign(
							new Error(`Private subprocess failed (${reason ?? code}); its effect may be uncertain.`),
							{ code, reason },
						),
					);
				} else resolve(stdout);
			},
		);
		function terminate(code: string) {
			if (failure) return;
			failure = Object.assign(new Error(code), { code });
			child.kill("SIGTERM");
			escalation = setTimeout(() => child.kill("SIGKILL"), 1500);
		}
		const abort = () => terminate("ABORT_ERR");
		const deadline = setTimeout(() => terminate("ETIMEDOUT"), options.timeoutMs ?? 45000);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}
