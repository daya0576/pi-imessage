// Real pinned CLI/Chrome fixture. Temporary HOME/profile/state, loopback pages only; no personal login or live model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createBrowser } from "../src/extensions/browser.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-browser-smoke-"));
const browser = await createBrowser(directory, getAgentDir());
let rotationResponse;
let confirmRotation;
const rotated = new Promise((resolve) => { confirmRotation = resolve; });
const server = createServer((request, response) => {
	if (request.url === "/wait-rotate") { rotationResponse = response; return; }
	if (request.url === "/confirm-rotate") { response.end("ok"); confirmRotation(); return; }
	if (request.url === "/a") response.setHeader("Set-Cookie", "fixture=alpha; Path=/; Max-Age=3600; SameSite=Lax");
	response.setHeader("Content-Type", "text/html");
	response.end(`<html><body><h1>Scope fixture</h1><p>cookie: ${request.headers.cookie || "none"}</p>
<input aria-label="Fixture input"><button onclick="this.textContent='clicked'">Click fixture</button>
<p id="local"></p><script>if(location.pathname==='/a')localStorage.setItem('fixture','alpha');
document.querySelector('#local').textContent='storage: '+(localStorage.getItem('fixture')||'none');
if(location.pathname==='/rotate')fetch('/wait-rotate').then(()=>{
document.cookie='fixture=beta; Path=/; Max-Age=3600; SameSite=Lax';localStorage.setItem('fixture','beta');fetch('/confirm-rotate');
});</script></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
	await browser.run(1, { action: "open", url: `${url}/a` });
	await browser.run(2, { action: "open", url: `${url}/` });
	const first = await browser.run(1, { action: "snapshot" });
	const second = await browser.run(2, { action: "snapshot" });
	assert(first.includes("storage: alpha"));
	assert(second.includes("storage: none"));
	assert(second.includes("cookie: none"));
	const ref = /textbox "Fixture input" \[ref=(e\d+)\]/.exec(first)?.[1];
	assert(ref, "Input ref from current snapshot");
	await browser.run(1, { action: "fill", ref, text: "--profile=/outside literal" });
	assert((await browser.run(1, { action: "snapshot" })).includes("--profile=/outside literal"));
	await browser.run(1, { action: "tab-new", url: `${url}/` });
	assert(/^\s*-?\s*1:/m.test(await browser.run(1, { action: "tab-list" })));
	assert(!/^\s*-?\s*1:/m.test(await browser.run(2, { action: "tab-list" })));
	await browser.run(1, { action: "screenshot" });
	const [hash] = await readdir(join(directory, "browser"));
	const scopes = [1, 2].map((id) => join(directory, "browser", hash, String(id)));
	assert((await readdir(join(scopes[0], "state", "output"))).some((file) => file.endsWith(".png")));
	assert(!(await readdir(join(scopes[1], "state", "output"))).some((file) => file.endsWith(".png")));
	for (const scope of scopes) {
		const config = JSON.parse(await readFile(join(scope, "cwd", ".playwright", "cli.config.json"), "utf8"));
		assert.equal(config.browser.launchOptions.headless, true);
		assert.equal((await stat(scope)).mode & 0o777, 0o700);
		assert.equal((await stat(join(scope, "state", "auth.json"))).mode & 0o777, 0o600);
		const { stdout } = await promisify(execFile)(join(getAgentDir(), "bin", "pi-browser"), ["list", "--all"], {
			cwd: join(scope, "cwd"),
			env: { HOME: join(scope, "home"), PI_BROWSER_HOME: join(scope, "state"), PATH: process.env.PATH },
			timeout: 10000,
		});
		assert(!stdout.includes(scopes.find((other) => other !== scope)), "Daemon discovery must not expose the other scope");
	}
	// Change authentication asynchronously after the last command's checkpoint; orderly close must capture it.
	await browser.run(1, { action: "goto", url: `${url}/rotate` });
	assert(rotationResponse, "Background fixture request has started");
	rotationResponse.end("rotate now");
	await rotated;
	await browser.close([1]);
	assert((await browser.run(2, { action: "snapshot" })).includes("storage: none"));
	const restarted = await createBrowser(directory, getAgentDir());
	await restarted.close();
	await assert.rejects(restarted.run(2, { action: "snapshot" }));
	await restarted.run(1, { action: "open", url: `${url}/` });
	const persisted = await restarted.run(1, { action: "snapshot" });
	assert(persisted.includes("cookie: fixture=beta"));
	assert(persisted.includes("storage: beta"));
	await restarted.close();
	console.log("Browser smoke passed: same-name sessions, registry, cookies/storage, tabs/files, literal argv, owned cleanup and retained login state.");
} finally {
	await browser.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
