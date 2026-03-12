/**
 * BlueBubbles REST API client.
 *
 * Only used for downloading attachments until the watch module replaces
 * the BB monitor (at which point attachments come from local disk).
 * Message sending is handled by src/send.ts via AppleScript.
 *
 * Requires BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD env vars.
 */

export interface BBConfig {
	url: string;
	password: string;
}

export function createBBClient(config: BBConfig) {
	const { url, password } = config;

	/**
	 * Download an attachment from BlueBubbles into memory and return its bytes.
	 * 30s timeout to accommodate large image files.
	 */
	async function downloadAttachmentBytes(guid: string): Promise<Buffer> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		let status = "ERR";
		try {
			const res = await fetch(
				`${url}/api/v1/attachment/${encodeURIComponent(guid)}/download?password=${encodeURIComponent(password)}`,
				{ method: "GET", signal: controller.signal }
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

	return { downloadAttachmentBytes };
}

export type BBClient = ReturnType<typeof createBBClient>;
