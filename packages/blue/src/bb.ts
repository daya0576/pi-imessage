/**
 * BlueBubbles REST API client.
 *
 * Handles communication with the BlueBubbles server for sending/receiving
 * iMessages. Requires BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD env vars.
 */

export interface BBConfig {
	url: string;
	password: string;
}

/** Incoming webhook payload from BlueBubbles (new-message event). */
export interface BBWebhookPayload {
	type: string;
	data: BBMessage;
}

/** A BlueBubbles message object (subset of fields we care about). */
export interface BBMessage {
	text: string | null;
	isFromMe: boolean;
	chats: Array<{ guid: string }>;
}

export function createBBClient(config: BBConfig) {
	const { url, password } = config;

	async function apiFetch(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
		const res = await fetch(`${url}/api/v1${path}?password=${encodeURIComponent(password)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`BB API ${path} failed: ${res.status} ${await res.text()}`);
		}
		return res.json();
	}

	return {
		async sendMessage(chatGuid: string, text: string): Promise<void> {
			await apiFetch("/message/text", {
				chatGuid,
				message: text,
				method: "private-api",
			});
		},

		async sendTypingIndicator(chatGuid: string): Promise<void> {
			// BlueBubbles typing indicator (best-effort, may not be supported)
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
