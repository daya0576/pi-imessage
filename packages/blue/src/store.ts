/**
 * Per-chat session store.
 *
 * Each chatGuid gets its own SessionManager instance, persisted under
 * `data/<chatGuid>/`. Sessions are created lazily on first message.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";

export interface Store {
	getSessionManager(chatGuid: string): SessionManager;
}

export function createStore(dataDir: string): Store {
	const sessions = new Map<string, SessionManager>();

	return {
		getSessionManager(chatGuid: string): SessionManager {
			let sm = sessions.get(chatGuid);
			if (!sm) {
				const chatDir = join(dataDir, sanitize(chatGuid));
				mkdirSync(chatDir, { recursive: true });
				sm = SessionManager.create(chatDir, chatDir);
				sessions.set(chatGuid, sm);
			}
			return sm;
		},
	};
}

/** Sanitize chatGuid for use as directory name. */
function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_\-;+.@]/g, "_");
}
