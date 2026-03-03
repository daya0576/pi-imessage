/**
 * BlueBubbles REST API client.
 *
 * Handles communication with the BlueBubbles server for sending
 * iMessages. Requires BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD env vars.
 */

import { randomUUID } from "node:crypto";

export interface BBConfig {
	url: string;
	password: string;
}

export function createBBClient(config: BBConfig) {
	const { url, password } = config;

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
	};
}

export type BBClient = ReturnType<typeof createBBClient>;
