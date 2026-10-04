import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
const browserState = await mkdtemp(join(tmpdir(), "imessage-browser-preflight-"));
try {
  // doctor can report MISSING with exit 0; --version must reach the installed runtime.
  await promisify(execFile)(process.env.PI_BROWSER_CLI_PATH ?? join(getAgentDir(), "bin", "pi-browser"), ["--version"], {
    env: { ...process.env, PI_BROWSER_HOME: browserState }, timeout: 10000, maxBuffer: 65536,
  });
} catch (error) {
  throw new Error("Browser CLI readiness failed; install the pinned runtime with pi-browser setup", { cause: error });
} finally {
  await rm(browserState, { recursive: true, force: true });
}
console.log("Preflight passed: macOS, Node, native SQLite/image dependencies, installed scheduler API and browser CLI runtime. No model, Messages or production workspace was accessed.");
