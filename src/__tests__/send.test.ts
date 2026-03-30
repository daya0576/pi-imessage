import { describe, expect, it, vi } from "vitest";
import { sendRichTextMessage } from "../rich-text.js";
import { createMessageSender } from "../send.js";
import type { RichTextSettings } from "../settings.js";

vi.mock("../rich-text.js", () => ({
	sendRichTextMessage: vi.fn().mockResolvedValue(undefined),
}));

const mockedSendRichTextMessage = vi.mocked(sendRichTextMessage);

describe("createMessageSender", () => {
	it("routes rich-text messages through the rich-text sender when enabled", async () => {
		const sender = createMessageSender();
		const richText: RichTextSettings = { enabled: true, markdown: true };

		await sender.sendMessage("iMessage;-;mergesort@me.com", "HEADER\nBody", richText);

		expect(mockedSendRichTextMessage).toHaveBeenCalledWith("iMessage;-;mergesort@me.com", "HEADER\nBody", {
			markdown: true,
		});
	});
});
