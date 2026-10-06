import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

// #33: CLI configuration/installation runs under a temp HOME without Messages, models or launchctl.
it("loads CLI environment without overriding explicit values and retains proxy configuration in the job", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "imessage-cli-")));
	const sockets = new Set<Duplex>();
	let proxyRequests = 0;
	let directRequests = 0;
	const proxy = createServer((_request, response) => {
		proxyRequests++;
		response.end("proxied");
	});
	proxy.on("connect", (_request, socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.once("data", () => {
			proxyRequests++;
			socket.end("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied");
		});
	});
	const direct = createServer((_request, response) => {
		directRequests++;
		response.end("direct");
	});
	try {
		await new Promise<void>((ready) => proxy.listen(0, "127.0.0.1", ready));
		await new Promise<void>((ready) => direct.listen(0, "127.0.0.1", ready));
		const proxyAddress = proxy.address();
		const directAddress = direct.address();
		if (
			!proxyAddress ||
			typeof proxyAddress === "string" ||
			!directAddress ||
			typeof directAddress === "string"
		)
			throw new Error("Missing fixture addresses");
		const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
		const environment = {
			HOME: directory,
			PATH: process.env.PATH,
			WORKING_DIR: join(directory, "workspace<&>"),
			PI_CODING_AGENT_DIR: "selected<&>/agent",
			HTTP_PROXY: proxyUrl,
			HTTPS_PROXY: `http://fixture-user:fake&password@127.0.0.1:${proxyAddress.port}`,
			NO_PROXY: "127.0.0.1,localhost",
			http_proxy: proxyUrl,
			https_proxy: `http://fixture-user:fake&password@127.0.0.1:${proxyAddress.port}`,
			no_proxy: "127.0.0.1,localhost",
			NODE_OPTIONS: "--no-warnings",
			TZ: "America/New_York",
		};
		const cli = resolve("src/cli.ts");
		const installed = await execute(process.execPath, ["--experimental-strip-types", cli, "install"], {
			cwd: directory,
			env: environment,
			timeout: 10_000,
		});
		expect(installed.stdout).toContain("Not loaded.");
		expect(installed.stdout + installed.stderr).not.toContain("fixture-user");
		const plist = join(directory, "Library", "LaunchAgents", "org.pi-imessage.service.plist");
		expect((await stat(plist)).mode & 0o777).toBe(0o600);
		const parser = join(directory, "parse-plist.py");
		await writeFile(
			parser,
			"import json, plistlib, sys\nwith open(sys.argv[1], 'rb') as file:\n print(json.dumps(plistlib.load(file)))\n",
		);
		const parsed = await execute("python3", [parser, plist], { env: environment });
		const job = JSON.parse(parsed.stdout) as {
			Label: string;
			ProgramArguments: string[];
			EnvironmentVariables: Record<string, string>;
			WorkingDirectory: string;
		};
		expect(job.Label).toBe("org.pi-imessage.service");
		expect(job.WorkingDirectory).toBe(directory);
		expect(job.EnvironmentVariables.PI_CODING_AGENT_DIR).toBe(join(directory, "selected<&>", "agent"));
		const directoryProbe = join(directory, "agent-directory-probe.mjs");
		await writeFile(
			directoryProbe,
			`import { getAgentDir } from ${JSON.stringify(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href)};\nconsole.log(getAgentDir());\n`,
		);
		const pinned = await execute(
			job.ProgramArguments[0],
			[...job.ProgramArguments.slice(1, -2), directoryProbe],
			{
				cwd: tmpdir(),
				env: { HOME: join(directory, "different-home"), ...job.EnvironmentVariables },
				timeout: 10_000,
			},
		);
		expect(pinned.stdout.trim()).toBe(join(directory, "selected<&>", "agent"));
		expect(job.ProgramArguments).toEqual([
			process.execPath,
			"--use-env-proxy",
			"--experimental-strip-types",
			cli,
			"serve",
		]);
		for (const key of [
			"WORKING_DIR",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"NO_PROXY",
			"http_proxy",
			"https_proxy",
			"no_proxy",
			"NODE_OPTIONS",
			"TZ",
		] as const)
			expect(job.EnvironmentVariables[key]).toBe(environment[key]);
		const client = join(directory, "proxy-client.mjs");
		await writeFile(
			client,
			`const proxied = await fetch("http://imessage-fixture.invalid/proxy", { signal: AbortSignal.timeout(3000) });\nconst direct = await fetch("http://127.0.0.1:${directAddress.port}/direct", { signal: AbortSignal.timeout(3000) });\nconsole.log(JSON.stringify([await proxied.text(), await direct.text()]));\n`,
		);
		const response = await execute(job.ProgramArguments[0], [...job.ProgramArguments.slice(1, -2), client], {
			env: { HOME: directory, ...job.EnvironmentVariables },
			timeout: 10_000,
		});
		expect(JSON.parse(response.stdout)).toEqual(["proxied", "direct"]);
		expect(proxyRequests).toBe(1);
		expect(directRequests).toBe(1);
		// #33 / ADR 0016: exercise the late process-owned setup under the same daemon flags.
		const transport = await execute(
			job.ProgramArguments[0],
			[...job.ProgramArguments.slice(1, -2), resolve("test/fixtures/http-transport.ts")],
			{ env: { HOME: directory, PATH: process.env.PATH }, timeout: 15_000 },
		);
		expect(transport.stdout).toContain("HTTP transport verified");
		const original = await readFile(plist, "utf8");
		await expect(
			execute(process.execPath, ["--experimental-strip-types", cli, "install"], {
				cwd: directory,
				env: environment,
				timeout: 10_000,
			}),
		).rejects.toThrow();
		expect(await readFile(plist, "utf8")).toBe(original);
		const fixtureSecret = "fake env value # & < >";
		await writeFile(
			join(directory, ".env"),
			`WORKING_DIR="${join(directory, "wrong-workspace")}"
WEB_PORT='7766'
PI_CODING_AGENT_DIR="~/file-agent<&>"
BRAVE_API_KEY="${fixtureSecret}"
HTTP_PROXY="${proxyUrl}"
NO_PROXY="127.0.0.1,localhost"
`,
		);
		const explicit = {
			HOME: directory,
			PATH: process.env.PATH,
			WORKING_DIR: environment.WORKING_DIR,
			WEB_PORT: "7788",
		};
		await rm(plist);
		const fromFile = await execute(process.execPath, ["--experimental-strip-types", cli, "install"], {
			cwd: directory,
			env: explicit,
			timeout: 10_000,
		});
		expect(fromFile.stdout + fromFile.stderr).not.toContain(fixtureSecret);
		const fileJob = JSON.parse(
			(await execute("python3", [parser, plist], { env: explicit })).stdout,
		) as typeof job;
		expect(fileJob.EnvironmentVariables).toMatchObject({
			WORKING_DIR: environment.WORKING_DIR,
			WEB_PORT: "7788",
			PI_CODING_AGENT_DIR: join(directory, "file-agent<&>"),
			BRAVE_API_KEY: fixtureSecret,
			HTTP_PROXY: proxyUrl,
			NO_PROXY: "127.0.0.1,localhost",
		});
		expect(fileJob.WorkingDirectory).toBe(directory);
		const probe = join(directory, "import-probe.mjs");
		await writeFile(
			probe,
			`import { main } from ${JSON.stringify(pathToFileURL(cli).href)};\nif (process.env.BRAVE_API_KEY !== undefined) throw new Error("Import loaded configuration");\nawait main(["--help"]);\nif (process.env.BRAVE_API_KEY !== undefined) throw new Error("Help loaded configuration");\nconsole.log("Import and help remained quiet");\n`,
		);
		const quiet = await execute(process.execPath, ["--experimental-strip-types", probe], {
			cwd: directory,
			env: explicit,
			timeout: 10_000,
		});
		expect(quiet.stdout).toContain("Import and help remained quiet");
		await expect(
			execute(
				process.execPath,
				["--experimental-strip-types", cli, "serve", "--run-scheduled", "fixture-job"],
				{
					cwd: directory,
					env: explicit,
					timeout: 10_000,
				},
			),
		).rejects.toThrow("Usage: serve --run-scheduled JOB --request-id ID");
		const overridePath = join(directory, "alternate & config.env");
		await writeFile(overridePath, 'WEB_PORT="7799"\nBRAVE_API_KEY="alternate fixture value"\n');
		const override = { ...explicit, WEB_PORT: undefined, DOTENV_CONFIG_PATH: overridePath };
		await rm(plist);
		await execute(process.execPath, ["--experimental-strip-types", cli, "install"], {
			cwd: directory,
			env: override,
			timeout: 10_000,
		});
		const overrideJob = JSON.parse(
			(await execute("python3", [parser, plist], { env: explicit })).stdout,
		) as typeof job;
		expect(overrideJob.EnvironmentVariables).toMatchObject({
			WEB_PORT: "7799",
			BRAVE_API_KEY: "alternate fixture value",
			DOTENV_CONFIG_PATH: overridePath,
			PI_CODING_AGENT_DIR: join(directory, ".pi", "agent"),
		});
		await expect(
			execute(process.execPath, ["--experimental-strip-types", cli, "install"], {
				cwd: directory,
				env: { ...explicit, DOTENV_CONFIG_PATH: join(overridePath, "not-a-file") },
				timeout: 10_000,
			}),
		).rejects.toThrow("Unable to load environment configuration");
		if (process.platform === "darwin") {
			// #33: a present wrapper is insufficient when its browser runtime is missing.
			const browserCli = join(directory, "browser-cli");
			await writeFile(
				browserCli,
				'#!/bin/sh\n[ "$1" = "--version" ] || exit 2\n[ -n "$PI_BROWSER_HOME" ] || exit 3\nprintf "%s" "$PI_BROWSER_HOME" > "$HOME/browser-state-path"\nprintf "0.1.19\\n"\n',
				{ mode: 0o700 },
			);
			const preflightEnvironment = {
				...explicit,
				PI_BROWSER_CLI_PATH: browserCli,
			};
			const preflight = await execute(
				process.execPath,
				["--experimental-strip-types", resolve("ops/preflight.mjs")],
				{ env: preflightEnvironment, timeout: 10_000 },
			);
			expect(preflight.stdout).toContain("browser CLI runtime");
			const temporaryBrowserState = await readFile(join(directory, "browser-state-path"), "utf8");
			expect(temporaryBrowserState).toContain("imessage-browser-preflight-");
			await expect(access(temporaryBrowserState)).rejects.toMatchObject({ code: "ENOENT" });
			await writeFile(browserCli, '#!/bin/sh\nprintf "runtime missing\\n" >&2\nexit 1\n');
			await expect(
				execute(process.execPath, ["--experimental-strip-types", resolve("ops/preflight.mjs")], {
					env: preflightEnvironment,
					timeout: 10_000,
				}),
			).rejects.toThrow("Browser CLI readiness failed");
		}
	} finally {
		for (const socket of sockets) socket.destroy();
		proxy.closeAllConnections();
		direct.closeAllConnections();
		await Promise.all([
			new Promise<void>((done) => proxy.close(() => done())),
			new Promise<void>((done) => direct.close(() => done())),
		]);
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
