/** Render the full HTML page from chat blocks using Eta templates. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { firstLinePreview, senderLabel } from "../store.js";
import type { ChatBlock } from "./data.js";
import { anchorId, formatTime } from "./html.js";

const MAX_MESSAGES = 30;
const TEN_MINUTES_MS = 10 * 60 * 1000;

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "templates");
const eta = new Eta({ views: templateDir, autoEscape: true });

/** A single row in the chat card table. */
interface MessageRow {
	gap: boolean;
	time: string;
	sender: string;
	arrow: string;
	text: string;
}

/** Pre-processed card data passed to the template. */
interface CardData {
	rows: MessageRow[];
}

/** Prepare the row data for a single chat card. */
function prepareCard(block: ChatBlock): CardData {
	const recent = block.messages.slice(-MAX_MESSAGES);

	const senders = recent.map((message) => senderLabel(message));
	const maxSenderLen = Math.max(...senders.map((s) => s.length));

	const rows: MessageRow[] = [];

	for (let i = 0; i < recent.length; i++) {
		const message = recent[i];
		if (!message) continue;

		const prev = recent[i - 1];
		if (prev) {
			const gapMs = new Date(message.date).getTime() - new Date(prev.date).getTime();
			if (gapMs > TEN_MINUTES_MS) {
				rows.push({ gap: true, time: "", sender: "", arrow: "", text: "" });
			}
		}

		rows.push({
			gap: false,
			time: formatTime(message.date),
			sender: senderLabel(message).padStart(maxSenderLen),
			arrow: message.isBot ? "&lt;-" : "-&gt;",
			text: firstLinePreview(message.text),
		});
	}

	return { rows };
}

export function renderPage(blocks: ChatBlock[]): string {
	return eta.render("page", { blocks, prepareCard, anchorId });
}
