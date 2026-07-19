/**
 * Send iMessages via macOS Messages.app AppleScript.
 *
 *   ┌──────────┐   AppleScript    ┌──────────────┐
 *   │ send.ts  │ ───────────────> │ Messages.app │
 *   └──────────┘                  └──────────────┘
 *
 * Supports DM (buddy), group chat (chat id), and SMS targets.
 * Check Messages.app environment before first send with checkEnvironment().
 *
 * Attachment sends stage the file into ~/Library/Messages/Attachments/pi-imessage/
 * because Messages.app's imagent helper is sandboxed and cannot read arbitrary
 * paths (e.g. ~/.pi/..., ~/dotfile/...); staged copies are then verified against
 * chat.db so we surface real failures instead of trusting AppleScript's ack.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, accessSync } from "node:fs";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { sendRichTextMessage } from "./rich-text.js";
import type { RichTextSettings } from "./settings.js";

const execFileAsync = promisify(execFile);
const SCRIPT_TIMEOUT_MS = 30_000;
const ATTACHMENT_VERIFY_TIMEOUT_MS = 30_000;
const ATTACHMENT_VERIFY_POLL_MS = 500;
const MESSAGES_APP_PATH = "/System/Applications/Messages.app";
const ATTACHMENTS_ROOT = join(homedir(), "Library", "Messages", "Attachments");
const STAGING_DIR = join(ATTACHMENTS_ROOT, "pi-imessage");
const CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

// ── AppleScript helpers ───────────────────────────────────────────────────────

/** Escape special characters for AppleScript string literals. */
function escapeAppleScript(str: string): string {
	return str
		.replace(/\0/g, "�")
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
		return `tell application "${MESSAGES_APP_PATH}"
	set targetChat to chat id "${escapedChatId}"
	send "${escapedText}" to targetChat
end tell`;
	}

	const recipient = escapeAppleScript(parts[2] ?? "");
	return `tell application "${MESSAGES_APP_PATH}"
	set targetService to 1st service whose service type = iMessage
	set targetBuddy to buddy "${recipient}" of targetService
	send "${escapedText}" to targetBuddy
end tell`;
}

/** Build AppleScript for sending a local file attachment. */
function buildSendAttachmentScript(chatGuid: string, filePath: string): string {
	const escapedPath = escapeAppleScript(filePath);
	const parts = chatGuid.split(";");
	const isGroup = parts[1] === "+";

	if (isGroup) {
		const escapedChatId = escapeAppleScript(chatGuid);
		return `tell application "${MESSAGES_APP_PATH}"
	set targetChat to chat id "${escapedChatId}"
	send POSIX file "${escapedPath}" to targetChat
end tell`;
	}

	const recipient = escapeAppleScript(parts[2] ?? "");
	return `tell application "${MESSAGES_APP_PATH}"
	set targetService to 1st service whose service type = iMessage
	set targetBuddy to buddy "${recipient}" of targetService
	send POSIX file "${escapedPath}" to targetBuddy
end tell`;
}

// ── Attachment staging & verification ─────────────────────────────────────────

/**
 * Copy an attachment into a location the sandboxed imagent process is allowed
 * to read. Paths under ~/Library/Messages/Attachments/ are proven-good; paths
 * under ~/.pi/... or ~/dotfile/... get rejected by TCC (Operation not permitted),
 * which shows up as transfer_state=6 / is_sent=0 in chat.db.
 *
 * Returns the staged path; caller is responsible for cleanup after send.
 */
async function stageAttachment(sourcePath: string): Promise<{ stagedPath: string; cleanup: () => Promise<void> }> {
	// If the source is already inside the Attachments root, imagent can read it.
	if (sourcePath.startsWith(`${ATTACHMENTS_ROOT}/`)) {
		return { stagedPath: sourcePath, cleanup: async () => {} };
	}

	await mkdir(STAGING_DIR, { recursive: true, mode: 0o755 });
	const ext = extname(sourcePath);
	const base = basename(sourcePath, ext)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 40);
	const stagedPath = join(STAGING_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}-${base}${ext}`);
	await copyFile(sourcePath, stagedPath);
	return {
		stagedPath,
		cleanup: async () => {
			try {
				await unlink(stagedPath);
			} catch {
				// best-effort; Messages may still hold a handle
			}
		},
	};
}

interface AttachmentStatus {
	attachmentId: number | null;
	transferState: number | null;
	isSent: number | null;
	error: number | null;
}

/** Poll chat.db until the staged attachment finishes transferring (or times out). */
async function verifyAttachmentSent(
	stagedPath: string,
	timeoutMs: number
): Promise<AttachmentStatus & { ok: boolean; detail: string }> {
	const stagedBase = basename(stagedPath);
	// filename in chat.db can be stored as absolute path or "~/Library/Messages/Attachments/...",
	// so match on the unique basename we generated (Date.now() + UUID prefix).
	const sql = `SELECT a.ROWID AS attachment_id, a.transfer_state, m.is_sent, m.error
		FROM attachment a
		LEFT JOIN message_attachment_join j ON j.attachment_id = a.ROWID
		LEFT JOIN message m ON m.ROWID = j.message_id
		WHERE a.filename LIKE '%${stagedBase.replace(/'/g, "''")}'
		ORDER BY a.ROWID DESC
		LIMIT 1;`;

	const deadline = Date.now() + timeoutMs;
	let last: AttachmentStatus = { attachmentId: null, transferState: null, isSent: null, error: null };

	while (Date.now() < deadline) {
		try {
			const { stdout } = await execFileAsync("sqlite3", ["-json", CHAT_DB_PATH, sql], { timeout: 5_000 });
			const rows = stdout.trim() ? (JSON.parse(stdout) as Array<Record<string, number | null>>) : [];
			const row = rows[0];
			if (row) {
				last = {
					attachmentId: (row.attachment_id as number) ?? null,
					transferState: (row.transfer_state as number) ?? null,
					isSent: (row.is_sent as number) ?? null,
					error: (row.error as number) ?? null,
				};
				// transfer_state: 5 = transferred, 6 = failed, other = in-progress/pending
				if (last.transferState === 5 && last.isSent === 1) {
					return {
						ok: true,
						detail: `attachment_id=${last.attachmentId} transfer_state=5 is_sent=1`,
						...last,
					};
				}
				if (last.transferState === 6) {
					return {
						ok: false,
						detail: `imagent rejected file (transfer_state=6, is_sent=${last.isSent}, error=${last.error}) — likely TCC/sandbox denial`,
						...last,
					};
				}
				if (last.error && last.error !== 0) {
					return {
						ok: false,
						detail: `message error=${last.error} transfer_state=${last.transferState} is_sent=${last.isSent}`,
						...last,
					};
				}
			}
		} catch (err) {
			// ignore transient sqlite lock errors; try again
			void err;
		}
		await new Promise((r) => setTimeout(r, ATTACHMENT_VERIFY_POLL_MS));
	}

	return {
		ok: false,
		detail: `timeout after ${timeoutMs}ms (attachment_id=${last.attachmentId} transfer_state=${last.transferState} is_sent=${last.isSent} error=${last.error})`,
		...last,
	};
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
	try {
		accessSync(CHAT_DB_PATH, constants.R_OK);
	} catch {
		throw new Error(
			`Cannot read ${CHAT_DB_PATH} — grant Full Disk Access to your terminal in System Settings > Privacy & Security > Full Disk Access`
		);
	}

	// 3. Check iMessage has active accounts
	const script = `tell application "${MESSAGES_APP_PATH}"
	try
		set accountList to every account
		if (count of accountList) is 0 then return "no_accounts"
		repeat with acct in accountList
			if enabled of acct is true then return "active"
		end repeat
		return "inactive"
	on error errorMessage number errorNumber
		return "error " & errorNumber & ": " & errorMessage
	end try
end tell`;

	try {
		const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 5_000 });
		const status = stdout.trim();
		if (status !== "active") {
			console.warn(
				`[send] iMessage account status check returned ${status}; continuing so the watchdog can diagnose send failures`
			);
		}
	} catch (error) {
		console.warn(
			`[send] failed to check iMessage status; continuing so the watchdog can diagnose send failures: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface MessageSender {
	sendMessage(chatGuid: string, text: string, richText?: RichTextSettings): Promise<void>;
	sendAttachment(chatGuid: string, filePath: string): Promise<void>;
}

export function createMessageSender(): MessageSender {
	return {
		async sendMessage(chatGuid: string, text: string, richText?: RichTextSettings): Promise<void> {
			const startTime = Date.now();
			const mode = richText?.enabled ? "rich" : "plain";
			console.log(`[send] start: ${chatGuid} mode=${mode} chars=${text.length}`);
			if (richText?.enabled) {
				await sendRichTextMessage(chatGuid, text, { markdown: richText.markdown });
				console.log(
					`[send] sent to ${chatGuid} mode=${mode} duration_ms=${Date.now() - startTime}: "${text.substring(0, 60)}"`
				);
				return;
			}
			const script = buildSendScript(chatGuid, text);
			await execFileAsync("osascript", ["-e", script], { timeout: SCRIPT_TIMEOUT_MS });
			console.log(
				`[send] sent to ${chatGuid} mode=${mode} duration_ms=${Date.now() - startTime}: "${text.substring(0, 60)}"`
			);
		},

		async sendAttachment(chatGuid: string, filePath: string): Promise<void> {
			const startTime = Date.now();
			accessSync(filePath, constants.R_OK);
			const origName = basename(filePath);
			console.log(`[send] start: ${chatGuid} mode=attachment file=${origName}`);

			const { stagedPath, cleanup } = await stageAttachment(filePath);
			const staged = stagedPath !== filePath;
			if (staged) {
				console.log(`[send] staged attachment for imagent: ${basename(stagedPath)}`);
			}

			try {
				const script = buildSendAttachmentScript(chatGuid, stagedPath);
				await execFileAsync("osascript", ["-e", script], { timeout: SCRIPT_TIMEOUT_MS });

				const status = await verifyAttachmentSent(stagedPath, ATTACHMENT_VERIFY_TIMEOUT_MS);
				if (!status.ok) {
					throw new Error(`attachment send failed for ${origName}: ${status.detail}`);
				}
				console.log(
					`[send] sent attachment to ${chatGuid} duration_ms=${Date.now() - startTime}: "${origName}" (${status.detail})`
				);
			} finally {
				if (staged) {
					// Give Messages a moment to fully ingest before removing the staged copy.
					setTimeout(() => {
						cleanup().catch(() => {});
					}, 60_000).unref();
				}
			}
		},
	};
}
