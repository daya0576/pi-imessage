import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAsyncQueue } from "../queue.js";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "queue-persistence-"));
	path = join(dir, "queue.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const read = () => {
	const { pending, inflight } = JSON.parse(readFileSync(path, "utf-8")) as { pending: string[]; inflight: string[] };
	return { pending, inflight };
};

describe("AsyncQueue persistence + ack replay", () => {
	it("keeps a pulled-but-unacked item in-flight and replays it on restart", async () => {
		const q = createAsyncQueue<string>(path);
		q.push("a");
		q.push("b");
		expect(read()).toEqual({ pending: ["a", "b"], inflight: [] });

		const first = await q.pull();
		expect(first).toBe("a");
		// Delivered but not acked → persisted as in-flight, not lost.
		expect(read()).toEqual({ pending: ["b"], inflight: ["a"] });

		// Simulate a crash/restart: new queue over the same file.
		const restarted = createAsyncQueue<string>(path);
		// Interrupted in-flight "a" replays ahead of pending "b".
		expect(await restarted.pull()).toBe("a");
		expect(await restarted.pull()).toBe("b");
	});

	it("drops an item from persistence only after ack", async () => {
		const q = createAsyncQueue<string>(path);
		q.push("x");
		const item = await q.pull();
		expect(read()).toEqual({ pending: [], inflight: ["x"] });
		q.ack(item);
		expect(read()).toEqual({ pending: [], inflight: [] });
	});

	it("does not replay an acked item after restart", async () => {
		const q = createAsyncQueue<string>(path);
		q.push("done");
		q.ack(await q.pull());
		const restarted = createAsyncQueue<string>(path);
		let resolved = false;
		void restarted.pull().then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
	});

	it("persists (does not wipe) pending and in-flight items on close", async () => {
		const q = createAsyncQueue<string>(path);
		q.push("pending");
		await q.pull(); // one becomes in-flight
		q.push("more-pending");
		q.close();
		expect(read()).toEqual({ pending: ["more-pending"], inflight: ["pending"] });

		const restarted = createAsyncQueue<string>(path);
		expect(await restarted.pull()).toBe("pending");
		expect(await restarted.pull()).toBe("more-pending");
	});

	it("tracks a directly-handed-off item (resolved waiter) as in-flight", async () => {
		const q = createAsyncQueue<string>(path);
		const pending = q.pull(); // waiter registered, buffer empty
		q.push("handoff");
		expect(await pending).toBe("handoff");
		// Bypassed the buffer but must still be persisted as in-flight for replay.
		expect(read()).toEqual({ pending: [], inflight: ["handoff"] });
	});

	it("accepts the legacy top-level array format as pending", async () => {
		writeFileSync(path, JSON.stringify(["legacy1", "legacy2"]));
		const q = createAsyncQueue<string>(path);
		expect(await q.pull()).toBe("legacy1");
		expect(await q.pull()).toBe("legacy2");
	});

	it("persists durable acceptance keys through handoff, ack and restart", async () => {
		const queue = createAsyncQueue<string>(path);
		const waiting = queue.pull();
		expect(queue.pushDurable("scheduled", "run-1")).toBe(true);
		expect(await waiting).toBe("scheduled");
		queue.ack("scheduled");
		const restarted = createAsyncQueue<string>(path);
		expect(restarted.pushDurable("duplicate", "run-1")).toBe(false);
		expect(read()).toEqual({ pending: [], inflight: [] });
		expect(JSON.parse(readFileSync(path, "utf-8")).acceptedKeys).toEqual(["run-1"]);
		expect(restarted.pushDurable("next", "run-2")).toBe(true);
		expect(await restarted.pull()).toBe("next");
	});

	it("does not accept or wake a consumer when durable persistence fails", async () => {
		const directory = join(dir, "missing");
		const queue = createAsyncQueue<string>(join(directory, "queue.json"));
		const waiting = queue.pull();
		expect(() => queue.pushDurable("retry", "run-1")).toThrow();
		mkdirSync(directory);
		expect(queue.pushDurable("retry", "run-1")).toBe(true);
		expect(await waiting).toBe("retry");
		queue.close();
		expect(() => queue.pushDurable("late", "run-2")).toThrow("Queue closed");
	});

	it("does not create a file when no persistPath is given", async () => {
		const q = createAsyncQueue<string>();
		q.push("ephemeral");
		expect(await q.pull()).toBe("ephemeral");
		expect(existsSync(path)).toBe(false);
	});
});
