#!/usr/bin/env node
// A fake subprocess boundary, not a browser driver. Real CLI/Chrome isolation is tested by ops/browser-smoke.mjs.
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const action = argv[1];
const values = argv.slice(argv.indexOf("--") + 1);
fs.appendFileSync(
	path.join(process.cwd(), "calls.jsonl"),
	`${JSON.stringify({
		argv,
		pid: process.pid,
		ownerLock: fs.existsSync(path.resolve(process.cwd(), "../../../..", "durable", "owner.lock")),
		cwd: process.cwd(),
		home: process.env.HOME,
		state: process.env.PI_BROWSER_HOME,
		inheritedTarget: process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT,
		inheritedDaemon: process.env.PWTEST_DAEMON_SESSION_DIR,
		inheritedSecret: process.env.BROWSER_FIXTURE_SECRET,
	})}\n`,
);
const active = path.join(process.env.PI_BROWSER_HOME, "fixture-active");
if (action === "list") {
	console.log(
		JSON.stringify({
			browsers: fs.existsSync(active)
				? [
						{
							name: "owned",
							status: "open",
							attached: false,
							userDataDir: path.join(process.env.PI_BROWSER_HOME, "profiles", "owned"),
						},
					]
				: [],
		}),
	);
	process.exit(0);
}
if (action === "close") fs.rmSync(active, { force: true });
if (action === "state-save") fs.writeFileSync(values[0], JSON.stringify({ cookies: [], origins: [] }));
if (action === "state-load") JSON.parse(fs.readFileSync(values[0], "utf8"));
if (action === "open") {
	fs.writeFileSync(active, "owned session open");
	fs.mkdirSync(path.join(process.env.PI_BROWSER_HOME, "profiles", "owned"), { recursive: true });
	fs.writeFileSync(
		path.join(process.env.PI_BROWSER_HOME, "profiles", "owned", "fixture.txt"),
		"retained login fixture",
	);
}
if (action === "snapshot") {
	const file = argv.find((value) => value.startsWith("--filename=")).slice("--filename=".length);
	fs.writeFileSync(file, '- textbox "Fixture" [ref=e1]\n');
}
if (action === "fill" && values[1] === "fixture-private-failure") {
	console.error("fixture-private-failure must never appear in the error returned to the model");
	process.exit(1);
}
if (action === "fill" && values[1] === "fixture-wait") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else console.log(`Fixture ${action} completed`);
