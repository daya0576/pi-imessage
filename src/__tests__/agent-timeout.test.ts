import { describe, expect, it, vi } from "vitest";
import { runWithActivityTimeout, runWithTimeout } from "../agent.js";

describe("runWithTimeout", () => {
	it("resolves with the operation's value when it completes before the timeout", async () => {
		const onTimeout = vi.fn();
		const result = await runWithTimeout(() => Promise.resolve("ok"), onTimeout, 1000);
		expect(result).toBe("ok");
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it("does not fire the timeout for a fast operation even after time advances", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			const p = runWithTimeout(() => Promise.resolve("fast"), onTimeout, 1000);
			await expect(p).resolves.toBe("fast");
			vi.advanceTimersByTime(5000);
			expect(onTimeout).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects with a timeout error and invokes onTimeout when the operation hangs", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn().mockResolvedValue(undefined);
			// A promise that never settles on its own — simulates a hung fetch.
			const hung = new Promise<string>(() => {});
			const p = runWithTimeout(() => hung, onTimeout, 120_000);
			// Attach rejection handler before advancing timers.
			const assertion = expect(p).rejects.toThrow(/timed out after 120000ms/);
			await vi.advanceTimersByTimeAsync(120_000);
			await assertion;
			expect(onTimeout).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects immediately without waiting for a hung timeout handler", async () => {
		vi.useFakeTimers();
		try {
			const neverFinishes = new Promise<void>(() => {});
			const onTimeout = vi.fn(() => neverFinishes);
			const operation = new Promise<string>(() => {});
			const p = runWithTimeout(() => operation, onTimeout, 5_000);
			const assertion = expect(p).rejects.toThrow(/timed out after 5000ms/);
			await vi.advanceTimersByTimeAsync(5_000);
			await assertion;
			expect(onTimeout).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still rejects when onTimeout itself throws (abort failure must not swallow the timeout)", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn().mockRejectedValue(new Error("abort failed"));
			const hung = new Promise<string>(() => {});
			const p = runWithTimeout(() => hung, onTimeout, 5_000);
			const assertion = expect(p).rejects.toThrow(/timed out after 5000ms/);
			await vi.advanceTimersByTimeAsync(5_000);
			await assertion;
			expect(onTimeout).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the timer so a rejecting operation does not later trigger onTimeout", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			const p = runWithTimeout(() => Promise.reject(new Error("boom")), onTimeout, 1000);
			await expect(p).rejects.toThrow("boom");
			vi.advanceTimersByTime(5000);
			expect(onTimeout).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("runWithActivityTimeout", () => {
	it("refreshes the idle timeout whenever activity is reported", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			let activity = () => {};
			const hung = new Promise<string>(() => {});
			const p = runWithActivityTimeout(
				(markActivity) => {
					activity = markActivity;
					return hung;
				},
				onTimeout,
				1000,
				10_000
			);
			const assertion = expect(p).rejects.toThrow(/idle timed out after 1000ms/);
			await vi.advanceTimersByTimeAsync(900);
			activity();
			await vi.advanceTimersByTimeAsync(900);
			expect(onTimeout).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(100);
			await assertion;
			expect(onTimeout).toHaveBeenCalledWith("idle");
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the maximum duration separate from the sliding idle timeout", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			let activity = () => {};
			const hung = new Promise<string>(() => {});
			const p = runWithActivityTimeout(
				(markActivity) => {
					activity = markActivity;
					return hung;
				},
				onTimeout,
				1000,
				2500
			);
			const assertion = expect(p).rejects.toThrow(/maximum duration of 2500ms/);
			await vi.advanceTimersByTimeAsync(800);
			activity();
			await vi.advanceTimersByTimeAsync(800);
			activity();
			await vi.advanceTimersByTimeAsync(800);
			activity();
			await vi.advanceTimersByTimeAsync(100);
			await assertion;
			expect(onTimeout).toHaveBeenCalledWith("max_duration");
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears both timers when the operation completes", async () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			const p = runWithActivityTimeout(() => Promise.resolve("ok"), onTimeout, 1000, 2000);
			await expect(p).resolves.toBe("ok");
			await vi.advanceTimersByTimeAsync(5000);
			expect(onTimeout).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
