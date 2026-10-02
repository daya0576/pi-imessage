import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyChatThinking, readChatThinking, writeChatThinking } from "../chat-thinking.js";

const roots: string[] = [];
function root() {
	const dir = mkdtempSync(join(tmpdir(), "chat-thinking-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("chat-local thinking", () => {
	it("max applies to only one chat, preserving global defaults byte-for-byte", () => {
		const dir = root();
		const global = join(dir, "settings.json");
		writeFileSync(global, '{"defaultThinkingLevel":"high"}\n');
		const before = readFileSync(global, "utf8");
		writeChatThinking(dir, "chat-a", "max");
		const a = { setThinkingLevel: vi.fn() };
		const b = { setThinkingLevel: vi.fn() };
		applyChatThinking(dir, "chat-a", a, "high");
		applyChatThinking(dir, "chat-b", b, "high");
		expect(a.setThinkingLevel).toHaveBeenCalledWith("max", { persist: false });
		expect(b.setThinkingLevel).toHaveBeenCalledWith("high", { persist: false });
		expect(readFileSync(global, "utf8")).toBe(before);
	});
	it("survives fresh sessions and reload fallback; default removes the override", () => {
		const dir = root();
		writeChatThinking(dir, "chat-a", "max");
		for (let n = 0; n < 3; n++) {
			const session = { setThinkingLevel: vi.fn() };
			applyChatThinking(dir, "chat-a", session, "high");
			expect(session.setThinkingLevel).toHaveBeenCalledWith("max", { persist: false });
		}
		writeChatThinking(dir, "chat-a", undefined);
		expect(readChatThinking(dir, "chat-a")).toBeUndefined();
	});
	it("rejects traversal and malformed levels instead of changing another scope", () => {
		const dir = root();
		for (const id of ["../other", "/tmp", "..", ".", "a\\b"]) expect(() => writeChatThinking(dir, id, "max")).toThrow();
		writeChatThinking(dir, "chat-a", "max");
		writeFileSync(join(dir, "chat-a", "agent-settings.json"), '{"thinkingLevel":"invented"}');
		expect(() => readChatThinking(dir, "chat-a")).toThrow();
	});
});
