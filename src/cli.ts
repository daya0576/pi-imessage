#!/usr/bin/env node
/**
 * CLI entry point — handles launchd service management and foreground run.
 *
 * Usage:
 *   pi-imessage              Run in foreground
 *   pi-imessage install      Install + start launchd service (auto-starts on boot)
 *   pi-imessage uninstall    Stop + remove launchd service
 *   pi-imessage start        Start the service
 *   pi-imessage stop         Stop the service
 *   pi-imessage restart      Restart the service
 *   pi-imessage logs         Tail service logs
 */

import { execSync, fork } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const LABEL = "com.kingcrab.pi-imessage";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const WORKING_DIR = process.env.WORKING_DIR || join(homedir(), ".pi", "imessage");
const WEB_HOST = process.env.WEB_HOST || "localhost";
const WEB_PORT = process.env.WEB_PORT || "7750";
const WEB_ENABLED = process.env.WEB_ENABLED || "true";
const LOG_DIR = join(WORKING_DIR, "logs");
const MAIN_JS = join(import.meta.dirname, "main.js");

function getNodePath(): string {
	try {
		return execSync("which node", { encoding: "utf-8" }).trim();
	} catch {
		return "/usr/local/bin/node";
	}
}

function buildPlist(): string {
	const nodePath = getNodePath();
	const stdoutLog = join(LOG_DIR, "stdout.log");
	const stderrLog = join(LOG_DIR, "stderr.log");

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${nodePath}</string>
		<string>${MAIN_JS}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${stdoutLog}</string>
	<key>StandardErrorPath</key>
	<string>${stderrLog}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
		<key>WORKING_DIR</key>
		<string>${WORKING_DIR}</string>
		<key>WEB_HOST</key>
		<string>${WEB_HOST}</string>
		<key>WEB_PORT</key>
		<string>${WEB_PORT}</string>
		<key>WEB_ENABLED</key>
		<string>${WEB_ENABLED}</string>
	</dict>
</dict>
</plist>`;
}

function isLoaded(): boolean {
	try {
		execSync(`launchctl list ${LABEL}`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function install(): void {
	mkdirSync(LOG_DIR, { recursive: true });
	writeFileSync(PLIST_PATH, buildPlist(), "utf-8");
	console.log(`[pi-imessage] Wrote ${PLIST_PATH}`);

	if (isLoaded()) {
		execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "inherit" });
	}
	execSync(`launchctl load ${PLIST_PATH}`, { stdio: "inherit" });
	console.log("[pi-imessage] Service installed and started (auto-starts on boot)");
}

function uninstall(): void {
	if (isLoaded()) {
		execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "inherit" });
		console.log("[pi-imessage] Service stopped");
	}
	if (existsSync(PLIST_PATH)) {
		unlinkSync(PLIST_PATH);
		console.log(`[pi-imessage] Removed ${PLIST_PATH}`);
	}
	console.log("[pi-imessage] Service uninstalled");
}

function start(): void {
	if (!existsSync(PLIST_PATH)) {
		console.error("[pi-imessage] Service not installed. Run 'pi-imessage install' first.");
		process.exit(1);
	}
	if (!isLoaded()) {
		execSync(`launchctl load ${PLIST_PATH}`, { stdio: "inherit" });
	}
	execSync(`launchctl start ${LABEL}`, { stdio: "inherit" });
	console.log("[pi-imessage] Service started");
}

function stop(): void {
	if (!isLoaded()) {
		console.log("[pi-imessage] Service is not running");
		return;
	}
	execSync(`launchctl stop ${LABEL}`, { stdio: "inherit" });
	console.log("[pi-imessage] Service stopped");
}

function restart(): void {
	if (isLoaded()) {
		execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "inherit" });
		console.log("[pi-imessage] Service stopped");
	}
	mkdirSync(LOG_DIR, { recursive: true });
	writeFileSync(PLIST_PATH, buildPlist(), "utf-8");
	console.log("[pi-imessage] Regenerated plist with current env vars");
	execSync(`launchctl load ${PLIST_PATH}`, { stdio: "inherit" });
	console.log("[pi-imessage] Service restarted");
}

function logs(): void {
	const stdoutLog = join(LOG_DIR, "stdout.log");
	const stderrLog = join(LOG_DIR, "stderr.log");

	if (!existsSync(stdoutLog) && !existsSync(stderrLog)) {
		console.error("[pi-imessage] No logs found. Is the service installed?");
		process.exit(1);
	}

	console.log("[pi-imessage] Tailing logs (Ctrl+C to stop)…\n");
	const files = [stdoutLog, stderrLog].filter((f) => existsSync(f));
	execSync(`tail -f ${files.join(" ")}`, { stdio: "inherit" });
}

function runForeground(): void {
	// Fork main.js as a child so cli.ts doesn't need to import the full bot.
	const child = fork(MAIN_JS, { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 0));
}

function help(): void {
	console.log(`pi-imessage v${version}

Usage: pi-imessage [command]

Commands:
  (none)       Run in foreground
  install      Install + start launchd service (auto-starts on boot)
  uninstall    Stop + remove launchd service
  start        Start the service
  stop         Stop the service
  restart      Restart the service
  logs         Tail service logs
  help         Show this help message`);
}

const command = process.argv[2];

switch (command) {
	case "install":
		install();
		break;
	case "uninstall":
		uninstall();
		break;
	case "start":
		start();
		break;
	case "stop":
		stop();
		break;
	case "restart":
		restart();
		break;
	case "logs":
		logs();
		break;
	case "help":
	case "--help":
	case "-h":
		help();
		break;
	case undefined:
		runForeground();
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		help();
		process.exit(1);
}
