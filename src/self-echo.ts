/**
 * Self-echo filter — prevents the bot from replying to its own messages.
 *
 * In a self-chat, the Messages app echoes outgoing messages back as incoming.
 * Register each outgoing reply with remember() before sending. When the echo
 * arrives, isEcho() detects the match and the caller drops the message.
 * Each entry is consumed on first match so identical human follow-ups pass through.
 */

// ── ExpiringSet ───────────────────────────────────────────────────────────────

/**
 * A multiset of strings where each entry expires after `ttlMs`.
 * Supports consume-on-match: `has()` removes the entry it matched.
 * Expired entries are pruned lazily on each read/write.
 */
interface ExpiringEntry {
	value: string;
	expiresAt: number;
}

function createExpiringSet(ttlMs: number) {
	const entries: ExpiringEntry[] = [];

	function prune(): void {
		const now = Date.now();
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].expiresAt <= now) entries.splice(i, 1);
		}
	}

	function add(value: string): void {
		prune();
		entries.push({ value, expiresAt: Date.now() + ttlMs });
	}

	/** Returns true and consumes the entry if found, false otherwise. */
	function consume(value: string): boolean {
		prune();
		const idx = entries.findIndex((e) => e.value === value);
		if (idx === -1) return false;
		entries.splice(idx, 1);
		return true;
	}

	return { add, consume };
}

// ── SelfEchoFilter ────────────────────────────────────────────────────────────

export interface SelfEchoFilter {
	/** Register a message we just sent so its echo can be suppressed. */
	remember(senderId: string, text: string): void;
	/**
	 * Returns true if this message looks like an echo of something we sent.
	 * Consumes the entry on match so an identical human follow-up is not dropped.
	 */
	isEcho(senderId: string, text: string): boolean;
}

export function createSelfEchoFilter(ttlMs = 60_000): SelfEchoFilter {
	const buckets = new Map<string, ReturnType<typeof createExpiringSet>>();

	function normalise(text: string): string {
		return text.trim().toLowerCase();
	}

	function getBucket(senderId: string) {
		let bucket = buckets.get(senderId);
		if (!bucket) {
			bucket = createExpiringSet(ttlMs);
			buckets.set(senderId, bucket);
		}
		return bucket;
	}

	function remember(senderId: string, text: string): void {
		getBucket(senderId).add(normalise(text));
	}

	function isEcho(senderId: string, text: string): boolean {
		return getBucket(senderId).consume(normalise(text));
	}

	return { remember, isEcho };
}
