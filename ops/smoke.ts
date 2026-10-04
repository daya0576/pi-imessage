// Operator-only live smoke: never called by tests or the agent. This deliberately costs model tokens and sends a message.
const args = process.argv.slice(2);
if (!args.includes("--live") || !args.includes("--chat") || !args[args.indexOf("--chat") + 1]) {
	console.log("Operator only: node --experimental-strip-types ops/smoke.ts --live --chat CHAT_GUID [--url http://localhost:7750]");
} else {
	const chatGuid = args[args.indexOf("--chat") + 1];
	const base = args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:7750";
	const health = await fetch(`${base}/health/model`);
	if (!health.ok) throw new Error(`Model health failed: ${health.status}`);
	console.log(await health.json());
	const requestId = `operator-smoke:${crypto.randomUUID()}`;
	const result = await fetch(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatGuid, prompt: "Reply with: authorized migration smoke received.", requestId }) });
	if (!result.ok) throw new Error(`Prompt admission failed: ${result.status}`);
	console.log(await result.json());
	console.log("Confirm exactly one reply on the destination device, then follow the remaining image/tools/scheduler/rollback checklist in ops/README.md.");
}
