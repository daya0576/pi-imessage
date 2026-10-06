#!/usr/bin/env -S node --use-env-proxy --experimental-strip-types
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { startApplication } from "./main.ts";
import { createMessageSender } from "./transport/send.ts";

export async function main(args = process.argv.slice(2)) {
	if (args.includes("--help") || args[0] === "help") {
		console.log(
			"pi-imessage [serve]\npi-imessage serve --run-scheduled JOB --request-id ID (one explicit run at startup)\npi-imessage install (write launchd job only)\nSee ops/README.md for operator-only installation, deployment and restart.",
		);
		return;
	}
	try {
		// Like the old dotenv entry point: cwd .env, with existing environment values taking priority.
		for (const [name, value] of Object.entries(
			parseEnv(await readFile(process.env.DOTENV_CONFIG_PATH ?? ".env", "utf8")),
		))
			if (process.env[name] === undefined && value !== undefined) process.env[name] = value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Unable to load environment configuration", { cause: error });
	}
	const workingDir = resolve(process.env.WORKING_DIR ?? join(homedir(), ".pi", "imessage"));
	const agentDir = resolve(getAgentDir());
	if (args[0] === "install") {
		const directory = join(homedir(), "Library", "LaunchAgents");
		await mkdir(directory, { recursive: true });
		await mkdir(workingDir, { recursive: true, mode: 0o700 });
		const xml = (value: string) =>
			value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
		const path = join(directory, "org.pi-imessage.service.plist");
		const environment = [
			"WEB_HOST",
			"WEB_PORT",
			"WEB_ENABLED",
			"MESSAGES_DB_PATH",
			"BRAVE_API_KEY",
			"BRAVE_SEARCH_API_KEY",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"NO_PROXY",
			"http_proxy",
			"https_proxy",
			"no_proxy",
			"NODE_OPTIONS",
			"TZ",
			"DOTENV_CONFIG_PATH",
		]
			.filter((key) => process.env[key] !== undefined)
			.map((key) => `<key>${key}</key><string>${xml(process.env[key] ?? "")}</string>`)
			.join("");
		await writeFile(
			path,
			`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>org.pi-imessage.service</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--use-env-proxy</string><string>--experimental-strip-types</string><string>${xml(fileURLToPath(import.meta.url))}</string><string>serve</string></array><key>WorkingDirectory</key><string>${xml(process.cwd())}</string><key>EnvironmentVariables</key><dict><key>PI_CODING_AGENT_DIR</key><string>${xml(agentDir)}</string><key>WORKING_DIR</key><string>${xml(workingDir)}</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string>${environment}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(workingDir, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(workingDir, "service.log"))}</string></dict></plist>`,
			{ flag: "wx", mode: 0o600 },
		);
		console.log(
			`Wrote ${path}. Not loaded. Follow ops/README.md for controller handover; never run two services.`,
		);
		return;
	}
	if (args.length && args[0] !== "serve") throw new Error("Unknown command; see --help");
	let runScheduled: { jobId: string; requestId: string } | undefined;
	if (args.length > 1) {
		if (
			args.length !== 5 ||
			args[1] !== "--run-scheduled" ||
			args[3] !== "--request-id" ||
			!args[2].trim() ||
			!args[4].trim()
		)
			throw new Error("Usage: serve --run-scheduled JOB --request-id ID");
		runScheduled = { jobId: args[2], requestId: args[4] };
	}
	const dbPath = process.env.MESSAGES_DB_PATH ?? join(homedir(), "Library", "Messages", "chat.db");
	const sender = createMessageSender({ attachmentsRoot: join(workingDir, "attachments"), dbPath });
	const app = await startApplication({
		workingDir,
		agentDir,
		...(runScheduled ? { runScheduled } : {}),
		dbPath,
		send: sender.sendMessage,
		sendAttachment: sender.sendAttachment,
		onError: (error) => console.error(new Date().toISOString(), "Messaging poll failed", error),
		web:
			process.env.WEB_ENABLED === "false"
				? false
				: { host: process.env.WEB_HOST ?? "localhost", port: Number(process.env.WEB_PORT ?? 7750) },
	});
	let closing = false;
	const stop = (signal: string) => {
		if (closing) return;
		closing = true;
		console.log(new Date().toISOString(), "Shutdown requested", { signal });
		void app.close().then(
			() => {
				console.log(new Date().toISOString(), "pi-imessage stopped");
			},
			(error) => {
				console.error(new Date().toISOString(), "Shutdown failed", error);
				process.exitCode = 1;
			},
		);
	};
	process.once("SIGINT", () => stop("SIGINT"));
	process.once("SIGTERM", () => stop("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	void main().catch((error) => {
		console.error(new Date().toISOString(), "Command failed", error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
