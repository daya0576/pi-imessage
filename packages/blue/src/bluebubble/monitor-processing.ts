/**
 * Message processing helpers for the BlueBubbles monitor.
 *
 * Self-echo filter:
 *   In a self-chat (iMessage sent to your own number), BlueBubbles fires two
 *   webhooks per message — one outgoing copy (isFromMe=true, filtered by the
 *   monitor) and one incoming copy (isFromMe=false). Without extra handling the
 *   bot would reply to its own outgoing messages, creating an infinite loop.
 *
 *   Register each outgoing reply with `remember()` before sending. When the
 *   incoming-copy webhook arrives, `isEcho()` detects the match and the caller
 *   should drop the message. Each entry is consumed on first match so an
 *   identical human follow-up is never silently dropped. Entries expire after
 *   `ttlMs` (default 60 s) regardless of whether they were consumed.
 */

interface SentEntry {
	normText: string;
	sentAt: number;
}

export interface SelfEchoFilter {
	/** Register a message we just sent so its echo can be suppressed. */
	remember(chatGuid: string, text: string): void;
	/**
	 * Returns true if this message looks like an echo of something we sent.
	 * Consumes the entry on match so an identical human follow-up is not dropped.
	 */
	isEcho(chatGuid: string, text: string): boolean;
}

export function createSelfEchoFilter(ttlMs = 60_000): SelfEchoFilter {
	const recentlySent = new Map<string, SentEntry[]>();

	function normalise(text: string): string {
		return text.trim().toLowerCase();
	}

	function remember(chatGuid: string, text: string): void {
		const entries = recentlySent.get(chatGuid) ?? [];
		entries.push({ normText: normalise(text), sentAt: Date.now() });
		recentlySent.set(chatGuid, entries);
	}

	function isEcho(chatGuid: string, text: string): boolean {
		const entries = recentlySent.get(chatGuid);
		if (!entries) return false;

		const norm = normalise(text);
		const cutoff = Date.now() - ttlMs;

		// Prune expired entries while we're here.
		const fresh = entries.filter((e) => e.sentAt >= cutoff);

		const idx = fresh.findIndex((e) => e.normText === norm);
		if (idx === -1) {
			// Write back pruned array even on a miss so stale entries don't linger.
			recentlySent.set(chatGuid, fresh);
			return false;
		}

		// Consume the entry, then persist.
		fresh.splice(idx, 1);
		recentlySent.set(chatGuid, fresh);
		return true;
	}

	return { remember, isEcho };
}
