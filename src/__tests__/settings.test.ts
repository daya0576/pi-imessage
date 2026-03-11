import { describe, expect, it } from "vitest";
import type { Settings } from "../settings.js";
import { isReplyEnabled } from "../settings.js";

function makeSettings(whitelist: string[], blacklist: string[]): Settings {
	return { chatAllowlist: { whitelist, blacklist } };
}

describe("isReplyEnabled", () => {
	it("whitelist ['*'] → reply to everyone", () => {
		const settings = makeSettings(["*"], []);
		expect(isReplyEnabled(settings, "1")).toBe(true);
		expect(isReplyEnabled(settings, "2")).toBe(true);
	});

	it("whitelist ['1'] → reply only to '1'", () => {
		const settings = makeSettings(["1"], []);
		expect(isReplyEnabled(settings, "1")).toBe(true);
		expect(isReplyEnabled(settings, "2")).toBe(false);
	});

	it("whitelist ['*'], blacklist ['2'] → reply to everyone except '2'", () => {
		const settings = makeSettings(["*"], ["2"]);
		expect(isReplyEnabled(settings, "1")).toBe(true);
		expect(isReplyEnabled(settings, "2")).toBe(false);
	});

	it("blacklist ['*'] → reply to nobody", () => {
		const settings = makeSettings([], ["*"]);
		expect(isReplyEnabled(settings, "1")).toBe(false);
	});

	it("whitelist ['1'], blacklist ['*'] → reply only to '1'", () => {
		const settings = makeSettings(["1"], ["*"]);
		expect(isReplyEnabled(settings, "1")).toBe(true);
		expect(isReplyEnabled(settings, "2")).toBe(false);
	});

	it("blacklist ['1'] > whitelist ['1'] → no reply", () => {
		const settings = makeSettings(["1"], ["1"]);
		expect(isReplyEnabled(settings, "1")).toBe(false);
	});

	it("empty lists → no reply", () => {
		const settings = makeSettings([], []);
		expect(isReplyEnabled(settings, "1")).toBe(false);
	});
});
