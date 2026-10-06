/** Process-local, bounded read cache. Versions come from commits or file metadata, never a TTL. */
export function createReadCache(maxEntries = 128, maxBytes = 16 * 1024 * 1024) {
	const entries = new Map<string, { version: string | number; promise: Promise<unknown>; bytes: number }>();
	let bytes = 0;
	function remove(key: string) {
		const entry = entries.get(key);
		if (entry) bytes -= entry.bytes;
		entries.delete(key);
	}
	return {
		delete: remove,
		async read<T>(
			key: string,
			version: () => string | number | Promise<string | number>,
			load: () => Promise<T>,
		): Promise<T> {
			for (;;) {
				const current = await version();
				let entry = entries.get(key);
				if (entry?.version !== current) {
					remove(key);
					entry = { version: current, bytes: 0, promise: Promise.resolve().then(load) };
					entries.set(key, entry);
				} else {
					entries.delete(key);
					entries.set(key, entry);
				}
				while (entries.size > maxEntries) remove(entries.keys().next().value as string);
				try {
					const value = (await entry.promise) as T;
					if ((await version()) !== current) continue;
					if (entries.get(key) === entry && entry.bytes === 0) {
						entry.bytes = Buffer.byteLength(JSON.stringify(value) ?? "null");
						bytes += entry.bytes;
						while (bytes > maxBytes) remove(entries.keys().next().value as string);
					}
					return value;
				} catch (error) {
					if (entries.get(key) === entry) remove(key);
					throw error;
				}
			}
		},
		clear() {
			entries.clear();
			bytes = 0;
		},
	};
}
