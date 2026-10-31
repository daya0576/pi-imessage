import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type TaskId } from "@earendil-works/pi-durable";

const execFileAsync = promisify(execFile);

export type RestartOptions = {
	workingDir: string;
	/** Directory of the running release; a target release is its sibling named by the full commit hash. */
	currentRelease: string;
	/** Parent of the private controller directories; `/tmp` in production. */
	deployRoot: string;
	/** Resolves once the calling tool task has settled, so the stop cannot interrupt the call. */
	settled(taskId: TaskId): Promise<unknown>;
	/** Starts the controller script; production opens it in Terminal. */
	launch(controller: string): Promise<void>;
};

/** Variables that describe the old shell session or that the controller sets itself. */
const EXCLUDED_ENVIRONMENT = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TERM_SESSION_ID"]);

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function processField(field: "lstart" | "command") {
	const { stdout } = await execFileAsync("ps", ["-p", String(process.pid), "-o", `${field}=`]);
	// Exactly what the controller's `$(ps ...)` yields: trailing newlines stripped, nothing else.
	return stdout.replace(/\n+$/, "");
}

/** Writes the private controller directory of ops/README.md step 3 for the target release; starts nothing. */
export async function prepareRestart(options: RestartOptions, release: string) {
	if (!/^[0-9a-f]{40}$/.test(release))
		throw new Error("release must be the full commit hash of a prepared release directory");
	const target = join(dirname(options.currentRelease), release);
	for (const entry of ["src/cli.ts", "node_modules", "ops/restart.command"]) {
		await access(join(target, entry)).catch(() => {
			throw new Error(`Release directory is not prepared: ${join(target, entry)} is missing`);
		});
	}
	const [started, command] = await Promise.all([processField("lstart"), processField("command")]);
	const deployDir = await mkdtemp(join(options.deployRoot, "pi-imessage-restart."));
	// The whole process environment, including .env values loaded at startup; the controller deletes the file.
	const environment = Object.entries(process.env)
		.filter(
			([name, value]) =>
				value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !EXCLUDED_ENVIRONMENT.has(name),
		)
		.map(([name, value]) => `export ${name}=${shellQuote(value ?? "")}`);
	await writeFile(join(deployDir, "environment.sh"), `${environment.join("\n")}\n`, { mode: 0o600 });
	const control = {
		OLD_PID: String(process.pid),
		OLD_STARTED: started,
		EXPECTED_COMMAND: command,
		REPO: target,
		NODE: process.execPath,
		WORKING_DIR: options.workingDir,
		WEB_PORT: process.env.WEB_PORT ?? "7750",
		LOG_FILE: join(options.workingDir, "service.log"),
	};
	await writeFile(
		join(deployDir, "control.sh"),
		`${Object.entries(control)
			.map(([name, value]) => `${name}=${shellQuote(value)}`)
			.join("\n")}\n`,
		{ mode: 0o600 },
	);
	const controller = join(deployDir, "restart.command");
	await copyFile(join(target, "ops", "restart.command"), controller);
	await chmod(controller, 0o700);
	return { target, deployDir, controller };
}

/** The claw baseline: a Terminal window keeps the controller alive independently of this process. */
export async function launchInTerminal(controller: string) {
	await execFileAsync("open", ["-a", "Terminal", controller], { timeout: 15_000 });
}

/** The chat assistant restarts the service through the host instead of a bash command that stops its own host. */
export function restartExtension(options: RestartOptions) {
	let scheduled: string | undefined;
	return defineExtension({
		name: "restart",
		tools: [
			defineTool({
				name: "restart_service",
				description:
					"Restart this service into a prepared release directory: a sibling of the running one named by its full commit hash, with npm ci and ops/preflight.mjs done. The service stops only after this call has settled; end the call at once and verify in a later call: controller.log and new.pid in the returned directory, then the service log, the listener and the running release directory. Never call it again before the first outcome is known.",
				parameters: Type.Object({
					release: Type.String({ description: "Full commit hash of the prepared release directory" }),
				}),
				// A rerun would launch a second controller (#39); an interrupted call is reported to the model instead.
				replay: "unsafe",
				async execute(args, api) {
					if (scheduled) throw new Error(`A restart is already scheduled from ${scheduled}`);
					const prepared = await prepareRestart(options, args.release);
					scheduled = prepared.deployDir;
					console.log(new Date().toISOString(), "Restart requested", {
						release: args.release,
						controller: prepared.deployDir,
						task: api.taskId,
					});
					void options
						.settled(api.taskId)
						.then(() => options.launch(prepared.controller))
						.catch((error) => {
							scheduled = undefined;
							console.error(new Date().toISOString(), "Restart launch failed", error);
						});
					return {
						output: [
							{
								type: "text",
								text: `Restart into ${prepared.target} is scheduled; the service stops after this call settles. Controller directory: ${prepared.deployDir}. Verify in a later call.`,
							},
						],
					};
				},
			}),
		],
	});
}
