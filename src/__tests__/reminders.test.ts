import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReminderService, createReminderService, parseReminderTime } from "../reminders.js";

const BASE_TIME = new Date("2026-08-08T12:00:00Z");

function makeWorkingDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-imessage-reminders-"));
}

describe("parseReminderTime", () => {
	it("requires an explicit timezone", () => {
		expect(parseReminderTime("2026-08-08T21:30:00+08:00")).toBe(new Date("2026-08-08T13:30:00Z").getTime());
		expect(() => parseReminderTime("2026-08-08T21:30:00")).toThrow("explicit timezone");
	});
});

describe("reminder service", () => {
	let workingDir: string;
	let service: ReminderService | null;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(BASE_TIME);
		workingDir = makeWorkingDir();
		service = null;
	});

	afterEach(async () => {
		await service?.stop();
		vi.useRealTimers();
		rmSync(workingDir, { recursive: true, force: true });
	});

	it("delivers a due reminder and records completion", async () => {
		const deliver = vi.fn().mockResolvedValue(undefined);
		service = createReminderService({ workingDir, deliver });
		service.start();
		const { reminder } = service.create({
			chatGuid: "iMessage;-;+11234567890",
			text: "check the camera",
			scheduledAt: "2026-08-08T12:00:01Z",
		});

		await vi.advanceTimersByTimeAsync(1_000);

		expect(deliver).toHaveBeenCalledOnce();
		expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: reminder.id, text: "check the camera" }));
		expect(service.list("delivered")).toEqual([
			expect.objectContaining({ id: reminder.id, status: "delivered", attempts: 1 }),
		]);
	});

	it("persists pending reminders across service restarts", async () => {
		service = createReminderService({ workingDir, deliver: vi.fn() });
		const { reminder } = service.create({
			chatGuid: "iMessage;-;+11234567890",
			text: "persistent reminder",
			scheduledAt: "2026-08-09T12:00:00Z",
		});
		await service.stop();

		service = createReminderService({ workingDir, deliver: vi.fn() });
		expect(service.list("pending")).toEqual([expect.objectContaining({ id: reminder.id })]);
	});

	it("retries failed deliveries and eventually succeeds", async () => {
		const deliver = vi.fn().mockRejectedValueOnce(new Error("Messages unavailable")).mockResolvedValueOnce(undefined);
		service = createReminderService({ workingDir, deliver, retryBaseMs: 1_000 });
		service.start();
		service.create({
			chatGuid: "iMessage;-;+11234567890",
			text: "retry me",
			scheduledAt: "2026-08-08T12:00:01Z",
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(service.list("pending")[0]).toEqual(
			expect.objectContaining({ attempts: 1, lastError: "Messages unavailable" })
		);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(deliver).toHaveBeenCalledTimes(2);
		expect(service.list("delivered")[0]).toEqual(expect.objectContaining({ attempts: 2 }));
	});

	it("supports idempotent creation and cancellation", () => {
		service = createReminderService({ workingDir, deliver: vi.fn() });
		const input = {
			chatGuid: "iMessage;-;+11234567890",
			text: "only once",
			scheduledAt: "2026-08-09T12:00:00Z",
			idempotencyKey: "camera-2026-08-09",
		};
		const first = service.create(input);
		const second = service.create(input);

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.reminder.id).toBe(first.reminder.id);
		expect(service.cancel(first.reminder.id)).toEqual(expect.objectContaining({ status: "cancelled" }));
		expect(service.cancel(first.reminder.id)).toBeNull();
	});
});
