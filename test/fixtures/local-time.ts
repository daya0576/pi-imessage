import assert from "node:assert/strict";
import { dailyTime, localDate, nextDaily } from "../../src/agent/time.ts";

// #33 / ADR 0034: isolated process timezone, no Harness, installed auth or external effects.
assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, process.env.TZ);
if (process.env.TZ === "UTC") {
	assert.equal(localDate(Date.parse("2026-10-07T02:00:00Z")), "2026-10-07");
	assert.equal(nextDaily("07:45", Date.parse("2026-10-07T07:40:00Z")), Date.parse("2026-10-07T07:45:00Z"));
	assert.equal(nextDaily("07:45", Date.parse("2026-10-07T07:45:00Z")), Date.parse("2026-10-08T07:45:00Z"));
	assert.equal(nextDaily("07:45", Date.parse("2026-01-31T08:00:00Z")), Date.parse("2026-02-01T07:45:00Z"));
	assert.equal(nextDaily("07:45", Date.parse("2026-12-31T08:00:00Z")), Date.parse("2027-01-01T07:45:00Z"));
} else if (process.env.TZ === "America/New_York") {
	assert.equal(localDate(Date.parse("2026-10-07T02:00:00Z")), "2026-10-06");
	assert.equal(nextDaily("07:45", Date.parse("2026-10-07T11:40:00Z")), Date.parse("2026-10-07T11:45:00Z"));
	// Calendar recurrence crosses spring/fall transitions in 23/25 hours, not 24.
	const spring = Date.parse("2026-03-07T12:45:00Z");
	assert.equal(nextDaily("07:45", spring), Date.parse("2026-03-08T11:45:00Z"));
	assert.equal(nextDaily("07:45", spring) - spring, 23 * 3600000);
	const fall = Date.parse("2026-10-31T11:45:00Z");
	assert.equal(nextDaily("07:45", fall), Date.parse("2026-11-01T12:45:00Z"));
	assert.equal(nextDaily("07:45", fall) - fall, 25 * 3600000);
	// A gap advances once; tomorrow returns to the requested wall time.
	assert.equal(dailyTime("02:30", Date.parse("2026-03-08T05:00:00Z")), Date.parse("2026-03-08T07:30:00Z"));
	assert.equal(nextDaily("02:30", Date.parse("2026-03-08T07:30:00Z")), Date.parse("2026-03-09T06:30:00Z"));
	// A repeated wall time picks the first occurrence and never schedules a second card that day.
	assert.equal(nextDaily("01:30", Date.parse("2026-11-01T05:00:00Z")), Date.parse("2026-11-01T05:30:00Z"));
	assert.equal(nextDaily("01:30", Date.parse("2026-11-01T05:30:00Z")), Date.parse("2026-11-02T06:30:00Z"));
} else {
	throw new Error("Unexpected fixture timezone");
}
console.log("Local schedule calendar verified");
