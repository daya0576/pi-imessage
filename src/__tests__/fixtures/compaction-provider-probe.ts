/** Opt-in, bounded provider probe. All state/auth copies must live in a disposable parent run directory. */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const destination = process.env.COMPACTION_PROBE_DIR;
if (!destination || !isAbsolute(destination) || !relative(process.cwd(), destination).startsWith("..")) {
	throw new Error(
		"Set COMPACTION_PROBE_DIR to a fresh absolute private artifact directory outside the source worktree"
	);
}
if (existsSync(destination)) throw new Error("Probe destination must be fresh; retain earlier evidence");
const scratch = resolve(destination);
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const authPath = join(scratch, "auth.json");
const evidence: Record<string, unknown> = {
	passed: false,
	real: [
		"installed SDK 0.85.1",
		"authenticated Astra high summarization",
		"normal provider prompt after SDK preflight compaction",
	],
	simulated: [
		"synthetic history",
		"last assistant usage 255641 to trigger default SDK threshold",
		"scratch keepRecentTokens=128",
	],
};
const events: { type: string; elapsedMs: number; reason?: string; success?: boolean; willRetry?: boolean }[] = [];
const started = Date.now();
const save = () =>
	writeFileSync(join(scratch, "evidence.json"), `${JSON.stringify({ ...evidence, events }, null, 2)}\n`, {
		mode: 0o600,
	});
const deadline = setTimeout(() => {
	evidence.failure = "Probe reached 180-second process deadline; provider lifecycle incomplete";
	save();
	rmSync(authPath, { force: true });
	process.exit(2);
}, 180_000);
try {
	copyFileSync(join(getAgentDir(), "auth.json"), authPath);
	chmodSync(authPath, 0o600);
	const modelsPath = join(scratch, "models.json");
	if (existsSync(join(getAgentDir(), "models.json"))) {
		copyFileSync(join(getAgentDir(), "models.json"), modelsPath);
		chmodSync(modelsPath, 0o600);
	}
	const runtime = await ModelRuntime.create({
		authPath,
		modelsPath,
		modelsStorePath: join(scratch, "models-store.json"),
	});
	const model = runtime.getModel("openai-codex", "gpt-6-astra");
	if (!model) throw new Error("Astra model unavailable");
	evidence.model = `${model.provider}/${model.id}`;
	const settingsManager = SettingsManager.inMemory({
		defaultThinkingLevel: "high",
		transport: "sse",
		packages: [],
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 128 },
		retry: { enabled: false, maxRetries: 0 },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: scratch,
		agentDir: scratch,
		settingsManager,
		systemPrompt: "You are a synthetic compaction probe. No tools. Answer the final user request exactly.",
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(scratch);
	for (let index = 0; index < 6; index++) {
		sessionManager.appendMessage({
			role: "user",
			content: `Synthetic test item ${index}: preserve the labels alpha beta gamma. ${"Example content only. ".repeat(30)}`,
			timestamp: Date.now() - 2000,
		});
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: `Synthetic item ${index} acknowledged.` }],
			stopReason: "stop",
			timestamp: Date.now() - 1000,
			usage: {
				input: index === 5 ? 255631 : 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: index === 5 ? 255641 : 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		sessionManager.appendMessage(message);
	}
	const { session } = await createAgentSession({
		cwd: scratch,
		agentDir: scratch,
		modelRuntime: runtime,
		model,
		thinkingLevel: "high",
		tools: [],
		resourceLoader,
		settingsManager,
		sessionManager,
	});
	let final = "";
	session.subscribe((event) => {
		if (event.type === "compaction_start")
			events.push({ type: event.type, reason: event.reason, elapsedMs: Date.now() - started });
		if (event.type === "compaction_end")
			events.push({
				type: event.type,
				reason: event.reason,
				elapsedMs: Date.now() - started,
				success: Boolean(event.result) && !event.aborted && !event.errorMessage,
				willRetry: event.willRetry,
			});
		if (event.type === "agent_start" || event.type === "agent_settled")
			events.push({ type: event.type, elapsedMs: Date.now() - started });
		if (event.type === "message_end" && event.message.role === "assistant") {
			final = event.message.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("");
			evidence.finalStopReason = event.message.stopReason;
		}
		save();
	});
	await session.prompt("Reply exactly COMPACTION_PROBE_OK.");
	evidence.promptCalls = 1;
	evidence.finalMatched = final.trim() === "COMPACTION_PROBE_OK";
	evidence.thinkingLevel = session.thinkingLevel;
	evidence.passed =
		events[0]?.type === "compaction_start" &&
		events[1]?.type === "compaction_end" &&
		events[1]?.success === true &&
		events.some((event) => event.type === "agent_start") &&
		evidence.finalMatched === true &&
		evidence.finalStopReason === "stop";
	session.dispose();
} catch (error) {
	// Keep raw errors out of source and user notices; only a private evidence file receives them.
	evidence.failure = error instanceof Error ? error.message : String(error);
} finally {
	clearTimeout(deadline);
	rmSync(authPath, { force: true });
	rmSync(join(scratch, "models.json"), { force: true });
	save();
}
console.log(JSON.stringify({ passed: evidence.passed, evidence: join(scratch, "evidence.json") }));
process.exit(evidence.passed ? 0 : 1);
