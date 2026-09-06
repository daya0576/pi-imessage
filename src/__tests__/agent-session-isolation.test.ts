import { describe, expect, it } from "vitest";
import { resolveSessionStorage } from "../agent.js";

describe("isolated agent session storage", () => {
	it("keeps normal chat sessions in the chat directory", () => {
		expect(resolveSessionStorage("/tmp/imessage", "iMessage;+;chat123")).toEqual({
			mapKey: "iMessage;+;chat123",
			sessionDir: "/tmp/imessage/iMessage;+;chat123",
			isolated: false,
		});
	});

	it("places task sessions outside the destination chat directory", () => {
		expect(
			resolveSessionStorage("/tmp/imessage", "iMessage;+;chat123", {
				sessionKey: "night-sleep-2026-09-01",
				ephemeral: true,
			})
		).toEqual({
			mapKey: "task:iMessage;+;chat123:night-sleep-2026-09-01",
			sessionDir: "/tmp/imessage/.task-sessions/iMessage;+;chat123/night-sleep-2026-09-01",
			isolated: true,
		});
	});

	it("scopes the same task key to its destination chat", () => {
		const first = resolveSessionStorage("/tmp/imessage", "chat-a", { sessionKey: "daily-task" });
		const second = resolveSessionStorage("/tmp/imessage", "chat-b", { sessionKey: "daily-task" });
		expect(first.mapKey).not.toBe(second.mapKey);
		expect(first.sessionDir).not.toBe(second.sessionDir);
	});

	it("rejects unsafe or incomplete ephemeral session options", () => {
		expect(() => resolveSessionStorage("/tmp/imessage", "chat", { ephemeral: true })).toThrow(
			"ephemeral sessions require sessionKey"
		);
		expect(() => resolveSessionStorage("/tmp/imessage", "chat", { sessionKey: "../escape" })).toThrow(
			"sessionKey must be"
		);
	});
});
