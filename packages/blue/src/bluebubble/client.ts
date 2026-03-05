/**
 * BlueBubbles REST API client.
 *
 * Handles communication with the BlueBubbles server for sending
 * iMessages and downloading attachments. Requires BLUEBUBBLES_URL
 * and BLUEBUBBLES_PASSWORD env vars.
 *
 * NOTE: The BlueBubbles API requires the password in the URL query string;
 * this is a server-side design decision, not an oversight on our part.
 */

import { randomUUID } from "node:crypto";

export interface BBConfig {
	url: string;
	password: string;
}

export function createBBClient(config: BBConfig) {
	const { url, password } = config;

	/** 10s timeout for JSON API calls (send message, typing indicator, etc.). */
	async function apiFetch(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		let status = "ERR";
		try {
			const res = await fetch(`${url}/api/v1${path}?password=${encodeURIComponent(password)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			status = String(res.status);
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`BB API ${path} failed: ${res.status} ${text}`);
			}
			const text = await res.text();
			let parsed: unknown;
			try { parsed = JSON.parse(text); } catch { parsed = text; }
			return parsed;
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				status = "timeout";
			} else if (!status) {
				status = "ERR";
			}
			throw err;
		} finally {
			clearTimeout(timer);
			console.log(`[BB] POST /api/v1${path} ${JSON.stringify(body)} -> ${status}`);
		}
	}

	/**
	 * Download an attachment from BlueBubbles into memory and return its bytes.
	 * 30s timeout (higher than apiFetch's 10s) to accommodate large image files.
	 *
	 * Intentionally keeps no local copy — the caller converts bytes directly to
	 * base64 ImageContent for the LLM. Add resize logic here if large images
	 * become a problem (resizeImage is not yet exported from pi-coding-agent).
	 */
	async function downloadAttachmentBytes(guid: string): Promise<Buffer> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		let status = "ERR";
		try {
			const res = await fetch(
				`${url}/api/v1/attachment/${encodeURIComponent(guid)}/download?password=${encodeURIComponent(password)}`,
				{ method: "GET", signal: controller.signal },
			);
			status = String(res.status);
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`BB attachment download ${guid} failed: ${res.status} ${text}`);
			}
			const arrayBuffer = await res.arrayBuffer();
			return Buffer.from(arrayBuffer);
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				status = "timeout";
			}
			throw err;
		} finally {
			clearTimeout(timer);
			console.log(`[BB] GET /api/v1/attachment/${guid}/download -> ${status}`);
		}
	}

	return {
		async sendMessage(chatGuid: string, text: string): Promise<void> {
			await apiFetch("/message/text", {
				chatGuid,
				message: text,
				tempGuid: randomUUID(),
			});
		},

		async sendTypingIndicator(chatGuid: string): Promise<void> {
			try {
				await apiFetch(`/chat/${encodeURIComponent(chatGuid)}/typing`, {
					status: "started",
				});
			} catch {
				// ignore — typing indicators are optional
			}
		},

		async sendReaction(chatGuid: string, messageGuid: string, reaction: string): Promise<void> {
			await apiFetch("/message/react", {
				chatGuid,
				selectedMessageGuid: messageGuid,
				reaction,
			});
		},

		downloadAttachmentBytes,
	};
}

export type BBClient = ReturnType<typeof createBBClient>;
