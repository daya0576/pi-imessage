/**
 * Pipeline task factories — each function creates a task for a specific
 * pipeline phase. Tasks are pure functions with injected dependencies;
 * the bot registers them without containing any business logic itself.
 *
 * before:
 *   logIncoming      — logs the received message
 *   dropSelfEcho     — drops messages that are echoes of the bot's own replies
 *   storeIncoming    — persists the incoming message to log.jsonl
 *   checkReplyEnabled — drops messages when reply is disabled by settings
 *   downloadImages   — reads image attachments from disk and populates incoming.images
 *   resizeImages     — resizes oversized images via macOS sips
 *
 * start:
 *   commandHandler   — intercepts slash commands (/new, /status, /reload) before the agent
 *   callAgent        — sends the message to the agent and yields replies as they arrive
 *
 * end:
 *   sendReply        — remembers echo, sends reply via Messages.app
 *   logOutgoing      — logs the outgoing reply
 *   storeOutgoing    — persists the outgoing reply to log.jsonl
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentManager } from "./agent.js";
import type { DigestLogger } from "./logger.js";
import type { BeforeTask, EmitFn, EndTask, StartTask } from "./pipeline.js";
import type { SelfEchoFilter } from "./self-echo.js";
import type { MessageSender } from "./send.js";
import type { Settings } from "./settings.js";
import { isReplyEnabled } from "./settings.js";
import type { ChatStore, Message } from "./store.js";
import { displayTarget, formatAgentReply } from "./types.js";
import type { AgentReply, ChatContext, IncomingMessage, OutgoingMessage } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function messageTypeLabel(chat: ChatContext): string {
	if (chat.messageType === "group") return "GROUP";
	return chat.messageType === "sms" ? "SMS" : "DM";
}

function formatIncomingTarget(chat: ChatContext, incoming: IncomingMessage): string {
	return chat.messageType === "group" ? `${chat.groupName}|${incoming.sender}` : incoming.sender;
}

// ── before tasks ──────────────────────────────────────────────────────────────

/**
 * Log the incoming message to console. Always passes through.
 *
 * Examples:
 *   [sid] <- [DM]    +16501234567: hey what's up
 *   [sid] <- [SMS]   +16501234567: can you call me
 *   [sid] <- [GROUP] Family|+16501234567: dinner at 6? [2 attachment(s)]
 */
export function createLogIncomingTask(digestLogger: DigestLogger): BeforeTask {
	return (chat, incoming, outgoing) => {
		const label = messageTypeLabel(chat);
		const target = formatIncomingTarget(chat, incoming);
		const attachmentNote = incoming.attachments.length > 0 ? ` [${incoming.attachments.length} attachment(s)]` : "";
		digestLogger.log(
			`[sid] <- [${label}] ${target}: ${(incoming.text ?? "(attachment)").substring(0, 80)}${attachmentNote}`
		);
		return outgoing;
	};
}

/** Persist the incoming message to log.jsonl. Always passes through. */
export function createStoreIncomingTask(store: ChatStore): BeforeTask {
	return (chat, incoming, outgoing) => {
		store
			.log(chat.chatGuid, {
				sender: incoming.sender,
				text: incoming.text,
				attachments: incoming.attachments.map((a) => a.path),
				fromAgent: false,
				messageType: chat.messageType,
				...(chat.messageType === "group" && { groupName: chat.groupName }),
			})
			.catch((error) => {
				console.error(`[sid] failed to store incoming message for ${chat.chatGuid}:`, error);
			});
		return outgoing;
	};
}

/** Drop messages that are echoes of the bot's own replies. */
export function createDropSelfEchoTask(echoFilter: SelfEchoFilter): BeforeTask {
	return (chat, incoming, outgoing) => {
		if (incoming.text && echoFilter.isEcho(chat.chatGuid, incoming.text)) {
			console.warn(`[sid] drop self-echo ${chat.chatGuid}: ${incoming.text.substring(0, 40)}`);
			return { ...outgoing, shouldContinue: false };
		}
		return outgoing;
	};
}

/**
 * Drop messages when reply is disabled for this chat by settings.
 *
 * Resolution priority (highest to lowest):
 *   blacklist["chatGuid"] > whitelist["chatGuid"] > blacklist["*"] > whitelist["*"]
 *
 * Examples:
 *   whitelist: ["*"]              → reply to everyone
 *   whitelist: ["1"]              → reply only to "1"
 *   whitelist: ["*"], bl: ["2"]   → reply to everyone except "2"
 *   blacklist: ["*"]              → log-only for all
 *   whitelist: ["1"], bl: ["*"]   → reply only to "1"
 *   whitelist: ["1"], bl: ["1"]   → no reply (blacklist wins)
 */
export function createCheckReplyEnabledTask(getSettings: () => Settings): BeforeTask {
	return (chat, _incoming, outgoing) => {
		if (!isReplyEnabled(getSettings(), chat.chatGuid)) {
			console.log(`[sid] reply disabled for ${chat.chatGuid}, log-only`);
			return { ...outgoing, shouldContinue: false };
		}
		return outgoing;
	};
}

/**
 * Read image attachments from local disk and populate incoming.images in-place.
 * Non-image attachments are skipped; failed reads are logged and silently skipped.
 */
export function createDownloadImagesTask(): BeforeTask {
	return async (_chat, incoming, outgoing) => {
		const images: ImageContent[] = [];
		for (const attachment of incoming.attachments) {
			const mimeType = attachment.mimeType;
			if (!mimeType?.startsWith("image/")) {
				console.warn(`[sid] skipping non-image attachment ${attachment.path} (mimeType: ${mimeType ?? "null"})`);
				continue;
			}
			try {
				const bytes = await readFile(attachment.path);
				images.push({ type: "image", mimeType, data: bytes.toString("base64") });
			} catch (error) {
				console.error(`[sid] failed to read image attachment ${attachment.path}:`, error);
			}
		}
		incoming.images = images;
		return outgoing;
	};
}

/**
 * Resize images whose longest edge exceeds MAX_EDGE_PX using macOS sips.
 * Converts to JPEG at 80% quality to keep size well under Anthropic's 5MB limit.
 *
 *   before: raw downloaded image (any size, any format)
 *   after:  JPEG ≤ MAX_EDGE_PX on longest edge, 80% quality
 *
 * Images that are already within the limit are left untouched.
 * Resize failures are logged and the original image is kept as-is.
 */
const MAX_EDGE_PX = 1024;

export function createResizeImagesTask(): BeforeTask {
	return async (_chat, incoming, outgoing) => {
		const resized: ImageContent[] = [];
		for (const image of incoming.images) {
			try {
				resized.push(await resizeImageIfNeeded(image));
			} catch (error) {
				console.error("[sid] failed to resize image, keeping original:", error);
				resized.push(image);
			}
		}
		incoming.images = resized;
		return outgoing;
	};
}

/**
 * Resize a single image if its longest edge exceeds MAX_EDGE_PX.
 * Uses macOS sips to resample and convert to JPEG at 80% quality.
 * Returns the original image unchanged if already within limits.
 */
const execFileAsync = promisify(execFile);

async function resizeImageIfNeeded(image: ImageContent): Promise<ImageContent> {
	const originalBytes = Buffer.from(image.data, "base64");
	const originalSizeKB = (originalBytes.length / 1024).toFixed(0);

	const tempDir = await mkdtemp(join(tmpdir(), "pi-imessage-resize-"));
	const inputPath = join(tempDir, "input");
	const outputPath = join(tempDir, "output.jpg");

	try {
		await writeFile(inputPath, originalBytes);

		// Get dimensions via sips
		const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", inputPath]);
		const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
		const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
		const width = widthMatch ? Number.parseInt(widthMatch[1], 10) : 0;
		const height = heightMatch ? Number.parseInt(heightMatch[1], 10) : 0;
		const longestEdge = Math.max(width, height);

		if (longestEdge <= MAX_EDGE_PX) {
			return image;
		}

		// Resize with sips — resampleHeightWidthMax scales the longest edge
		await execFileAsync("sips", [
			"--resampleHeightWidthMax",
			String(MAX_EDGE_PX),
			"-s",
			"format",
			"jpeg",
			"-s",
			"formatOptions",
			"80",
			inputPath,
			"--out",
			outputPath,
		]);

		const resizedBytes = await readFile(outputPath);
		const resizedSizeKB = (resizedBytes.length / 1024).toFixed(0);
		console.log(`[sid] resized image: ${width}x${height} ${originalSizeKB}KB → ${MAX_EDGE_PX}px ${resizedSizeKB}KB`);

		return { type: "image", mimeType: "image/jpeg", data: resizedBytes.toString("base64") };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

// ── start tasks ───────────────────────────────────────────────────────────────

/**
 * Intercept slash commands (e.g. "/new", "/status") before they reach the agent.
 * Sets shouldContinue=false on the outgoing message to skip subsequent start tasks.
 *
 * Supported commands:
 *   /new    — reset the agent session for this chat (equivalent to /new in pi coding agent).
 *   /status — show session stats: tokens, cost, context usage, model, thinking level.
 *   /reload — reload models and clear all sessions.
 */
export function createCommandHandlerTask(agent: AgentManager): StartTask {
	return async (chat, incoming, outgoing, emit) => {
		const text = incoming.text?.trim();

		if (text === "/new") {
			await agent.newSession(chat.chatGuid);
			const newSessionReply = "✓ New session started";
			console.log(`[sid] /new command: ${chat.chatGuid} → ${newSessionReply}`);
			emit({ ...outgoing, reply: { type: "message", text: newSessionReply } });

			const statusReply = await agent.getSessionStatus(chat.chatGuid);
			console.log(`[sid] /new status: ${chat.chatGuid} → ${statusReply}`);
			emit({ ...outgoing, reply: { type: "message", text: statusReply } });

			outgoing.shouldContinue = false;
			return;
		}

		if (text === "/status") {
			const replyText = await agent.getSessionStatus(chat.chatGuid);
			console.log(`[sid] /status command: ${chat.chatGuid} → ${replyText}`);
			emit({ ...outgoing, reply: { type: "message", text: replyText } });
			outgoing.shouldContinue = false;
			return;
		}

		if (text === "/reload") {
			await agent.reload(chat.chatGuid);
			const statusReply = await agent.getSessionStatus(chat.chatGuid);
			const replyText = `✓ Models reloaded\n${statusReply}`;
			console.log(`[sid] /reload command: ${chat.chatGuid} → ${replyText}`);
			emit({ ...outgoing, reply: { type: "message", text: replyText } });
			outgoing.shouldContinue = false;
			return;
		}
	};
}

/** Decorator: wrap a StartTask with retry logic for transient errors. */
function withRetry(task: StartTask, options: { delays: number[]; retryable: (message: string) => boolean }): StartTask {
	return async (chat, incoming, outgoing, emit) => {
		const { delays, retryable } = options;
		for (let attempt = 0; ; attempt++) {
			try {
				await task(chat, incoming, outgoing, emit);
				return;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				if (attempt >= delays.length || !retryable(message)) throw error;
				const delay = delays[attempt];
				console.log(
					`[agent] retrying ${chat.chatGuid} (attempt ${attempt + 2}/${delays.length + 1}) ` +
						`in ${delay / 1000}s: ${message.substring(0, 80)}`
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	};
}

/** Send the message to the agent and dispatch a reply for each agent turn. */
export function createCallAgentTask(agent: AgentManager): StartTask {
	const task: StartTask = async (_chat, incoming, outgoing, emit) => {
		await agent.processMessage(incoming, async (agentReply) => {
			const text = formatAgentReply(agentReply);
			emit({ ...outgoing, reply: { type: "message" as const, text } });
		});
	};
	return withRetry(task, {
		delays: [1000, 5000, 10000],
		retryable: (msg) => msg.includes("timed out") || msg.includes("Authentication failed"),
	});
}

// ── end tasks ─────────────────────────────────────────────────────────────────

/** Remember echo and send reply via Messages.app AppleScript. */
export function createSendReplyTask(echoFilter: SelfEchoFilter, sender: MessageSender): EndTask {
	return async (chat, outgoing) => {
		if (outgoing.reply.type === "message") {
			echoFilter.remember(chat.chatGuid, outgoing.reply.text);
			await sender.sendMessage(chat.chatGuid, outgoing.reply.text);
		}
		return outgoing;
	};
}

/**
 * Log the outgoing reply to console.
 *
 * Examples:
 *   [sid] -> [DM]    +16501234567: sure, I'll check
 *   [sid] -> [SMS]   +16501234567: got it
 *   [sid] -> [GROUP] Family: sounds good!
 */
export function createLogOutgoingTask(digestLogger: DigestLogger): EndTask {
	return (chat, outgoing) => {
		const { reply } = outgoing;
		if (reply.type === "message") {
			const label = messageTypeLabel(chat);
			const target = displayTarget(chat);
			digestLogger.log(`[sid] -> [${label}] ${target}: ${reply.text.substring(0, 80)}`);
		}
		return outgoing;
	};
}

/** Persist the outgoing reply to log.jsonl. */
export function createStoreOutgoingTask(store: ChatStore): EndTask {
	return (chat, outgoing) => {
		if (outgoing.reply.type === "message") {
			store
				.log(chat.chatGuid, {
					sender: "bot",
					text: outgoing.reply.text,
					attachments: [],
					fromAgent: true,
					messageType: chat.messageType,
					...(chat.messageType === "group" && { groupName: chat.groupName }),
				})
				.catch((error) => {
					console.error(`[sid] failed to store outgoing message for ${chat.chatGuid}:`, error);
				});
		}
		return outgoing;
	};
}
