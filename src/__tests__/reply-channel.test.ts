import type { Message } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { extractMessageText } from "../agent.js";

it("omits commentary text while preserving final answers and unsigned text", () => {
	const message = {
		role: "user",
		content: [
			{ type: "text", text: "Let me plan", textSignature: JSON.stringify({ v: 1, id: "a", phase: "commentary" }) },
			{ type: "text", text: "完成", textSignature: JSON.stringify({ v: 1, id: "b", phase: "final_answer" }) },
			{ type: "text", text: "正常回复", textSignature: "legacy" },
		],
		timestamp: 0,
	} as Message;
	expect(extractMessageText(message)).toBe("完成\n正常回复");
});
