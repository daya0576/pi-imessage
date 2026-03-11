/** Render the full HTML page from chat blocks using Eta templates. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { isReplyEnabled } from "../settings.js";
import type { Settings } from "../settings.js";
import { firstLinePreview, senderLabel } from "../store.js";
import type { MessageType } from "../types.js";
import type { ChatBlock } from "./data.js";
import { anchorId, formatTime } from "./html.js";

const MAX_MESSAGES = 15;
const TEN_MINUTES_MS = 10 * 60 * 1000;

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "templates");
const eta = new Eta({ views: templateDir, autoEscape: true });

/** A single row in the chat card table. */
interface MessageRow {
	gap: boolean;
	time: string;
	arrow: string;
	channel: string;
	sender: string;
	text: string;
}

/** Map MessageType to a display channel tag. */
function channelLabel(messageType: MessageType): string {
	if (messageType === "group") return "[GROUP]";
	if (messageType === "sms") return "[SMS]";
	return "[DM]";
}

/** Pre-processed card data passed to the template. */
interface CardData {
	rows: MessageRow[];
}

/** Prepare the row data for a single chat card. */
function prepareCard(block: ChatBlock): CardData {
	const recent = block.messages.slice(-MAX_MESSAGES);
	const rows: MessageRow[] = [];

	for (let i = 0; i < recent.length; i++) {
		const message = recent[i];
		if (!message) continue;

		const prev = recent[i - 1];
		if (prev) {
			const gapMs = new Date(message.date).getTime() - new Date(prev.date).getTime();
			if (gapMs > TEN_MINUTES_MS) {
				rows.push({ gap: true, time: "", arrow: "", channel: "", sender: "", text: "" });
			}
		}

		rows.push({
			gap: false,
			time: formatTime(message.date),
			arrow: message.isBot ? "->" : "<-",
			channel: channelLabel(message.messageType),
			sender: senderLabel(message),
			text: firstLinePreview(message.text),
		});
	}

	return { rows };
}

export function renderPage(blocks: ChatBlock[], settings: Settings): string {
	const replyEnabledMap = (chatGuid: string) => isReplyEnabled(settings, chatGuid);
	return eta.render("page", { blocks, prepareCard, anchorId, replyEnabledMap });
}
