/**
 * Send iMessages via macOS Messages.app AppleScript.
 *
 *   ┌──────────┐   AppleScript    ┌──────────────┐
 *   │ send.ts  │ ───────────────> │ Messages.app │
 *   └──────────┘                  └──────────────┘
 *
 * Supports DM (buddy), group chat (chat id), and SMS targets.
 * Check Messages.app environment before first send with checkEnvironment().
 */

import { execFile } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_TIMEOUT_MS = 30_000;

// ── AppleScript helpers ───────────────────────────────────────────────────────

/** Escape special characters for AppleScript string literals. */
function escapeAppleScript(str: string): string {
	return str
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

/**
 * Build the AppleScript for sending a text message.
 *
 * chatGuid format (from iMessage database):
 *   "iMessage;-;+1234567890"    → DM   → send via buddy
 *   "iMessage;+;chat123..."     → group → send via chat id
 *   "SMS;-;+1234567890"         → SMS   → send via buddy
 */
function buildSendScript(chatGuid: string, text: string): string {
	const escapedText = escapeAppleScript(text);
	const parts = chatGuid.split(";");
	const isGroup = parts[1] === "+";

	if (isGroup) {
		const escapedChatId = escapeAppleScript(chatGuid);
		return `tell application "Messages"
	set targetChat to chat id "${escapedChatId}"
	send "${escapedText}" to targetChat
end tell`;
	}

	const recipient = escapeAppleScript(parts[2] ?? "");
	return `tell application "Messages"
	set targetService to 1st service whose service type = iMessage
	set targetBuddy to buddy "${recipient}" of targetService
	send "${escapedText}" to targetBuddy
end tell`;
}

// ── Environment check ─────────────────────────────────────────────────────────

/** Check Messages.app is running and iMessage is signed in. */
export async function checkEnvironment(): Promise<void> {
	// 1. Check Messages.app process
	try {
		await execFileAsync("pgrep", ["-x", "Messages"], { timeout: 5_000 });
	} catch {
		throw new Error("Messages.app is not running");
	}

	// 2. Check Full Disk Access (required to read chat.db)
	const chatDbPath = join(homedir(), "Library", "Messages", "chat.db");
	try {
		accessSync(chatDbPath, constants.R_OK);
	} catch {
		throw new Error(
			`Cannot read ${chatDbPath} — grant Full Disk Access to your terminal in System Settings > Privacy & Security > Full Disk Access`
		);
	}

	// 3. Check iMessage has active accounts
	const script = `tell application "Messages"
	try
		set accountList to every account
		if (count of accountList) is 0 then return "no_accounts"
		repeat with acct in accountList
			if enabled of acct is true then return "active"
		end repeat
		return "inactive"
	on error
		return "error"
	end try
end tell`;

	try {
		const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 5_000 });
		const status = stdout.trim();
		if (status !== "active") {
			throw new Error(`iMessage account status: ${status}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("iMessage account")) throw error;
		throw new Error(`Failed to check iMessage status: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface MessageSender {
	sendMessage(chatGuid: string, text: string): Promise<void>;
}

export function createMessageSender(): MessageSender {
	return {
		async sendMessage(chatGuid: string, text: string): Promise<void> {
			const script = buildSendScript(chatGuid, text);
			await execFileAsync("osascript", ["-e", script], { timeout: SCRIPT_TIMEOUT_MS });
			console.log(`[send] sent to ${chatGuid}: "${text.substring(0, 60)}"`);
		},
	};
}
