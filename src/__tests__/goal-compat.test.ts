import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { goalCommand, importLegacyGoal } from "../goal-compat.js";

const root = mkdtempSync(join(tmpdir(), "goal-compat-"));
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("preserves legacy checkpoints, imports once and leaves unknown/completed operations paused", () => {
	for (const state of ["running", "completed", "blocked", "cleared"]) {
		const directory = join(root, state);
		mkdirSync(directory, { recursive: true });
		const path = join(directory, "goal.json");
		const bytes = JSON.stringify({
			version: 1,
			chatGuid: state,
			generation: "00000000-0000-0000-0000-000000000000",
			objective: "Original objective",
			state,
			progress: "Progress",
			reason: "Unknown result",
			evidence: "Reported evidence",
			turns: 2,
			limit: 4,
		});
		writeFileSync(path, bytes);
		const persist = vi.fn();
		importLegacyGoal(directory, persist);
		importLegacyGoal(directory, persist);
		expect(readFileSync(path, "utf8")).toBe(bytes);
		if (state === "cleared") expect(persist).not.toHaveBeenCalled();
		else {
			expect(persist).toHaveBeenCalledTimes(1);
			expect(persist.mock.calls[0][0]).toMatchObject({
				objective: "Original objective",
				status: state === "blocked" ? "blocked" : "paused",
				autoContinue: false,
			});
			expect(persist.mock.calls[0][0].pauseReason).toMatch(/turns=2\/4.*\nProgress: Progress\nReason: Unknown result/);
		}
	}
});

it("does not consume failed writes or accept symlinked/corrupt legacy state", () => {
	mkdirSync(join(root, "chat"), { recursive: true });
	const directory = join(root, "chat");
	const path = join(directory, "goal.json");
	const record = {
		version: 1,
		chatGuid: "chat",
		generation: "00000000-0000-0000-0000-000000000000",
		objective: "Keep",
		state: "paused",
		progress: "",
		reason: "",
		evidence: "",
		turns: 0,
		limit: 4,
	};
	writeFileSync(path, JSON.stringify(record));
	expect(() =>
		importLegacyGoal(directory, () => {
			throw new Error("disk full");
		})
	).toThrow("disk full");
	const persist = vi.fn();
	importLegacyGoal(directory, persist);
	expect(persist).toHaveBeenCalledTimes(1);
	writeFileSync(path, JSON.stringify({ ...record, turns: 5 }));
	expect(() => importLegacyGoal(directory, persist)).toThrow("Invalid legacy goal");
	rmSync(path);
	symlinkSync(join(root, "elsewhere"), path);
	expect(() => importLegacyGoal(directory, persist)).toThrow("Unsafe legacy goal");
});

it("maps exact legacy user commands, not quoted commands or ordinary prose", () => {
	expect(goalCommand("/goal resume")).toEqual({ name: "goal-resume", args: "" });
	expect(goalCommand("/goal Original objective")).toEqual({ name: "goal-direct", args: "Original objective" });
	expect(goalCommand("/goal-status health")).toEqual({ name: "goal-status", args: "health" });
	expect(goalCommand("Please run /goal resume")).toBeUndefined();
});
