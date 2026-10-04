import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

// #33: launchd preparation retains proxy settings without loading a job or accessing Messages/models.
it("retains proxy configuration in the installed job and routes native fetch with NO_PROXY bypass", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-cli-"));
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
			HTTP_PROXY: proxyUrl,
			HTTPS_PROXY: `http://fixture-user:fake&password@127.0.0.1:${proxyAddress.port}`,
			NO_PROXY: "127.0.0.1,localhost",
			http_proxy: proxyUrl,
			https_proxy: `http://fixture-user:fake&password@127.0.0.1:${proxyAddress.port}`,
			no_proxy: "127.0.0.1,localhost",
			NODE_OPTIONS: "--no-warnings",
		};
		const cli = resolve("src/cli.ts");
		const installed = await execute(process.execPath, ["--experimental-strip-types", cli, "install"], {
			cwd: directory,
			env: environment,
			timeout: 10_000,
		});
		expect(installed.stdout).toContain("Not loaded.");
		expect(installed.stdout + installed.stderr).not.toContain("fixture-user");
		const plist = join(directory, "Library", "LaunchAgents", "me.changchen.pi-imessage-durable.plist");
		expect((await stat(plist)).mode & 0o777).toBe(0o600);
		const parser = join(directory, "parse-plist.py");
		await writeFile(
			parser,
			"import json, plistlib, sys\nwith open(sys.argv[1], 'rb') as file:\n print(json.dumps(plistlib.load(file)))\n",
		);
		const parsed = await execute("python3", [parser, plist], { env: environment });
		const job = JSON.parse(parsed.stdout) as {
			ProgramArguments: string[];
			EnvironmentVariables: Record<string, string>;
		};
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
		const original = await readFile(plist, "utf8");
		await expect(
			execute(process.execPath, ["--experimental-strip-types", cli, "install"], {
				cwd: directory,
				env: environment,
				timeout: 10_000,
			}),
		).rejects.toThrow();
		expect(await readFile(plist, "utf8")).toBe(original);
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
}, 15_000);
