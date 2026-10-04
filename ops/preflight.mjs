import assert from "node:assert/strict";
import Database from "better-sqlite3";
import sharp from "sharp";
import { schedulerBackend } from "../src/scheduler/backend.ts";

assert.equal(process.platform, "darwin", "Messages transport requires macOS");
const version = process.versions.node.split(".").map(Number);
assert.ok(version[0] > 22 || (version[0] === 22 && (version[1] > 22 || (version[1] === 22 && version[2] >= 2))), "Node 22.22.2 or newer is required");
const database = new Database(":memory:");
try { assert.equal(database.prepare("SELECT 1 AS value").get().value, 1); } finally { database.close(); }
assert.equal((await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer()).length > 0, true);
const backend = schedulerBackend();
for (const name of ["createCronService", "createReminderService", "createSchedulerService", "createBackgroundService"]) assert.equal(typeof backend[name], "function", name);
console.log("Preflight passed: macOS, Node, native SQLite/image dependencies and installed scheduler API. No model, Messages or production workspace was accessed.");
