import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";

/** Shared conversation ordering uses message activity, not conversation creation order. */
export function historyActivity(history: Page<EntryRecord, Cursor>) {
	let latest = 0;
	for (const entry of history.items) {
		for (const message of entry.model ?? []) {
			if ("timestamp" in message && Number.isFinite(message.timestamp))
				latest = Math.max(latest, message.timestamp);
		}
		const data = entry.data;
		if (!data || typeof data !== "object" || Array.isArray(data)) continue;
		const original = data.original;
		if (!original || typeof original !== "object" || Array.isArray(original)) continue;
		const date = typeof original.date === "string" ? Date.parse(original.date) : 0;
		if (Number.isFinite(date)) latest = Math.max(latest, date);
	}
	return latest;
}

/** Preserve displayed messages and pagination without shipping model-only payloads. */
export function displayHistory(history: Page<EntryRecord, Cursor>, limit?: number) {
	const items = history.items.flatMap((entry) => {
		const model = (entry.model ?? []).flatMap((message) => {
			if (message.role !== "user" && message.role !== "assistant") return [];
			if (message.role === "assistant" && message.stopReason === "toolUse") return [];
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.map((block) =>
								block.type === "text"
									? block.text
									: block.type === "image"
										? "[Image attachment]"
										: block.type === "toolCall"
											? `[Tool: ${block.name}]`
											: "",
							)
							.filter(Boolean)
							.join("\n");
			return content ? [{ role: message.role, content, timestamp: message.timestamp }] : [];
		});
		if (!model.length) return [];
		const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {};
		const original =
			data.original && typeof data.original === "object" && !Array.isArray(data.original)
				? data.original
				: {};
		return [
			{
				id: entry.id,
				model,
				data: {
					legacy: data.legacy,
					original: {
						date: original.date,
						sender: original.sender,
						senderName: original.senderName,
						groupName: original.groupName,
					},
				},
			},
		];
	});
	if (limit === undefined) return { items, next: history.next, groupName: undefined };
	// Limit messages, not entries; order matches the browser, including imported dates.
	const rows = items
		.flatMap((entry) =>
			entry.model
				.filter((message) => message.content.replace(/^\[(?:Group '[^']*'|DM|SMS) from [^\]]+\] /, ""))
				.map((message) => ({
					message,
					time: Number(message.timestamp) || Date.parse(String(entry.data.original.date ?? "")) || 0,
					groupName:
						entry.data.original.groupName || message.content.match(/^\[Group '([^']*)' from [^\]]+\] /)?.[1],
				})),
		)
		.sort((left, right) => left.time - right.time);
	const groupName = rows.findLast((row) => row.groupName)?.groupName;
	const selected = new Set(rows.slice(-limit).map((row) => row.message));
	return {
		items: items.flatMap((entry) => {
			const model = entry.model.filter((message) => selected.has(message));
			return model.length ? [{ ...entry, model }] : [];
		}),
		next: history.next,
		groupName,
	};
}
