#!/usr/bin/env -S node --use-env-proxy --experimental-strip-types
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv, promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import sharp from "sharp";
import { startApplication } from "./main.ts";
import { createMessageSender } from "./transport/send.ts";

/** Checks this machine can run the service; touches no model, Messages or workspace. */
async function preflight() {
	assert.equal(process.platform, "darwin", "Messages transport requires macOS");
	const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
	assert.ok(
		major > 22 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))),
		"Node 22.22.2 or newer is required",
	);
	const database = new Database(":memory:");
	try {
		assert.equal(database.prepare<[], { value: number }>("SELECT 1 AS value").get()?.value, 1);
	} finally {
		database.close();
	}
	const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
		.jpeg()
		.toBuffer();
	assert.ok(image.length > 0, "Image dependency produced no output");
	const browserState = await mkdtemp(join(tmpdir(), "imessage-browser-preflight-"));
	try {
		// doctor can report MISSING with exit 0; --version must reach the installed runtime.
		await promisify(execFile)(
			process.env.PI_BROWSER_CLI_PATH ?? join(getAgentDir(), "bin", "pi-browser"),
			["--version"],
			{ env: { ...process.env, PI_BROWSER_HOME: browserState }, timeout: 10000, maxBuffer: 65536 },
		);
	} catch (error) {
		throw new Error("Browser CLI readiness failed; install the pinned runtime with pi-browser setup", {
			cause: error,
		});
	} finally {
		await rm(browserState, { recursive: true, force: true });
	}
	console.log(
		"Preflight passed: macOS, Node, native SQLite/image dependencies and browser CLI runtime. No model, Messages or production workspace was accessed.",
	);
}

export async function main(args = process.argv.slice(2)) {
	if (args.includes("--help") || args[0] === "help") {
		console.log(
			"pi-imessage [serve]\npi-imessage install (write launchd job only)\npi-imessage preflight (check this machine)\nSee docs/install.md.",
		);
		return;
	}
	if (args[0] === "preflight") return preflight();
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
		console.log(`Wrote ${path}. Not loaded. Load it yourself; never run two services.`);
		return;
	}
	if (args.length && args[0] !== "serve") throw new Error("Unknown command; see --help");
	if (args.length > 1)
		throw new Error("Unknown serve arguments; use workspace configuration and reload_extensions");
	const dbPath = process.env.MESSAGES_DB_PATH ?? join(homedir(), "Library", "Messages", "chat.db");
	// Incoming archives stay in the workspace; outgoing staging uses Messages' readable root.
	const sender = createMessageSender({ dbPath });
	const app = await startApplication({
		workingDir,
		agentDir,
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

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
	void main().catch((error) => {
		console.error(new Date().toISOString(), "Command failed", error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
