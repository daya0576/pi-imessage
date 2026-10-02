// Issue #28 acceptance: real SDK sessions + the user's ACTUAL enabled Pi config and installed
// extensions, with a stub model stream (no model request leaves the process).
//
//   npx tsx ops/acceptance-extensions.mjs          # offline checks
//   npx tsx ops/acceptance-extensions.mjs --live   # + headless Chromium on example.com and a real web_search
//
// ACCEPTANCE_SEARCH_PROVIDER pins the live search provider (e.g. brave, duckduckgo).
//
// PI_CODING_AGENT_DIR overrides the agent dir (default ~/.pi/agent). Exits non-zero on failure.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { HEADLESS_BUILTIN_TOOLS, createHeadlessResourceLoader } from "../src/headless-extensions.ts";

const live = process.argv.includes("--live");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
const root = mkdtempSync(join(tmpdir(), "pi-imessage-acceptance-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);

const modelRuntime = await ModelRuntime.create({
	authPath: join(root, "auth.json"),
	modelsPath: join(root, "models.json"),
	refreshOnCreate: false,
});
const model = modelRuntime.getModels("openai-codex").find((candidate) => /^gpt-/.test(candidate.id));
assert.ok(model, "openai-codex gpt model missing from the catalog");
// Stubbed transport: credentials are never read and no request is sent.
modelRuntime.hasConfiguredAuth = () => true;
const payloads = [];
modelRuntime.streamSimple = (requestModel, _context, options) => {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		payloads.push(await options?.onPayload?.({ model: requestModel.id, input: [] }, requestModel));
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
	})();
	return stream;
};

async function openChat(key, readOnly = false) {
	const sessionDir = join(root, key);
	mkdirSync(join(sessionDir, "goals"), { recursive: true });
	const settingsManager = SettingsManager.create(workspace, agentDir);
	const resourceLoader = createHeadlessResourceLoader({
		cwd: workspace,
		agentDir,
		sessionDir,
		settingsManager,
		readOnly,
		// busy() keeps pi-goal-x from claiming checkpoints; acceptance never runs goal turns.
		...(readOnly
			? {}
			: {
					goal: { storageRoot: join(sessionDir, "goals"), busy: () => true, continue: () => assert.fail("goal turn") },
				}),
		systemPrompt: "Acceptance",
		log: () => {},
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, [], `${key}: extension load errors`);
	const { session } = await createAgentSession({
		model,
		cwd: workspace,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(workspace),
		...(readOnly ? { tools: ["read"] } : {}),
	});
	await session.bindExtensions({ onError: (error) => assert.fail(`${error.extensionPath}: ${error.error}`) });
	return { session, resourceLoader };
}
const close = async ({ session }) => {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
};
const tool = ({ session }, name) => {
	const found = session.agent.state.tools.find((candidate) => candidate.name === name);
	assert.ok(found, `${name} not callable`);
	return found;
};
const text = (result) => result.content.map((entry) => entry.text ?? "").join("\n");
const providerHookCount = ({ resourceLoader }) =>
	resourceLoader
		.getExtensions()
		.extensions.reduce(
			(count, extension) => count + (extension.handlers.get("before_provider_request")?.length ?? 0),
			0
		);
// pi-goal-x adds a payload-only prompt-cache hook; it never requests a turn.
const expectedHooks = () => 1 + (loaded.has("pi-goal-x") ? 1 : 0);
const toolNames = ({ session }) => session.getAllTools().map((candidate) => candidate.name);
const checkBuiltins = ({ session }, when) => {
	for (const name of HEADLESS_BUILTIN_TOOLS)
		assert.ok(session.getActiveToolNames().includes(name), `${when}: builtin ${name} inactive`);
};

const results = [];
const step = async (name, run) => {
	await run();
	results.push(name);
	console.log(`ok - ${name}`);
};

const chatA = await openChat("chat-a");
const chatB = await openChat("chat-b");
const readOnly = await openChat("background-summary", true);
const audit = chatA.resourceLoader.getHeadlessAudit();
const loaded = new Set(audit.loaded);
console.log(`agentDir=${agentDir} model=${model.provider}/${model.id} node=${process.version}`);
console.log(`loaded: ${audit.loaded.join(", ")}`);
for (const skipped of audit.skipped) console.log(`skipped: ${skipped.path} (${skipped.reason})`);
console.log(`tools: ${toolNames(chatA).join(", ")}`);
console.log(`active: ${chatA.session.getActiveToolNames().join(", ")}`);

try {
	await step("loaded tool names", async () => {
		assert.ok(loaded.has("openai-codex-fast"), "openai-codex-fast not loaded");
		checkBuiltins(chatA, "initial");
		const names = toolNames(chatA);
		for (const name of new Set(names)) assert.equal(names.filter((entry) => entry === name).length, 1, name);
		if (loaded.has("pi-web-access")) assert.ok(names.includes("web_search"), "web_search missing");
		if (loaded.has("pi-browser-actions")) {
			assert.ok(names.includes("browser_session"), "browser_session missing");
			assert.ok(!names.includes("browser_web_search") && !names.includes("web_fetch"), "browser duplicate tools");
		}
		if (loaded.has("pi-subagents")) assert.ok(names.includes("Agent"), "native Agent missing");
		assert.ok(!names.includes("claw_agent") || !audit.skipped.some((entry) => entry.reason === "self-delegation"));
		const skills = chatA.resourceLoader.getSkills().skills.map((skill) => skill.name);
		if (loaded.has("pi-web-access")) assert.ok(!skills.includes("brave-search"), "brave-search skill still loaded");
		if (loaded.has("pi-browser-actions")) assert.ok(!skills.includes("browser"), "browser skill still loaded");
	});

	await step("provider hook runs once per request", async () => {
		assert.equal(providerHookCount(chatA), expectedHooks());
		await chatA.session.prompt("acceptance");
		assert.deepEqual(payloads, [{ model: model.id, input: [], service_tier: "priority" }]);
	});

	await step("reload keeps native tools and one provider hook", async () => {
		await chatA.session.reload();
		checkBuiltins(chatA, "after reload");
		assert.equal(providerHookCount(chatA), expectedHooks());
		await chatA.session.prompt("after reload");
		assert.equal(payloads.length, 2);
		assert.equal(payloads[1].service_tier, "priority");
	});

	await step("two-chat isolation", async () => {
		assert.notEqual(tool(chatA, "read"), tool(chatB, "read"));
		if (loaded.has("pi-web-access")) {
			chatA.session.sessionManager.appendCustomEntry("web-search-results", { id: "acceptance-response" });
			await assert.rejects(
				tool(chatB, "get_search_content").execute("cached", { responseId: "acceptance-response" }),
				/does not belong to this session/
			);
		}
		if (loaded.has("pi-browser-actions"))
			await assert.rejects(
				tool(chatA, "browser_session").execute("attach", { action: "attach", name: "chat-b" }),
				/attachment and session discovery are disabled/
			);
	});

	if (loaded.has("pi-goal-x"))
		await step("pi-goal-x goal pool is per chat", async () => {
			await tool(chatA, "create_goal").execute("goal", { objective: "Acceptance goal" });
			const pool = (key) => readdirSync(join(root, key, "goals")).filter((name) => name.startsWith("active_goal_"));
			assert.equal(pool("chat-a").length, 1);
			assert.deepEqual(pool("chat-b"), []);
			assert.match(text(await tool(chatB, "get_goal").execute("get", {})), /no (active|focused) goal|No goal/i);
		});

	await step("read-only summary is restricted to read", async () => {
		assert.deepEqual(readOnly.session.getActiveToolNames(), ["read"]);
		assert.deepEqual(readOnly.session.getCallableToolNames(), ["read"]);
		assert.deepEqual(readOnly.resourceLoader.getSkills().skills, []);
		assert.ok(readOnly.resourceLoader.getHeadlessAudit().loaded.every((kind) => kind === "openai-codex-fast"));
	});

	if (live && loaded.has("pi-browser-actions"))
		await step("live private headless Chromium per chat", async () => {
			const open = (chat) =>
				tool(chat, "browser_session").execute("open", { action: "open", url: "https://example.com" });
			await Promise.all([open(chatA), open(chatB)]);
			for (const chat of [chatA, chatB]) {
				const snapshot = text(await tool(chat, "browser").execute("snapshot", { action: "snapshot" }));
				assert.match(snapshot, /Example Domain/);
				await tool(chat, "browser_session").execute("close", { action: "close" });
			}
		});

	if (live && loaded.has("pi-web-access"))
		await step("live readable fetch via pi-web-access", async () => {
			const result = await tool(chatA, "fetch_content").execute("fetch", {
				url: "https://www.iana.org/domains/reserved",
				mode: "readable",
			});
			assert.doesNotMatch(text(result), /^Error:/m);
			assert.match(text(result), /reserved|example domains/i);
			assert.equal(result.details.successful, 1);
			assert.ok(result.details.totalChars > 500);
		});

	if (live && loaded.has("pi-web-access"))
		await step("live raw web_search via pi-web-access", async () => {
			const result = await tool(chatA, "web_search").execute("search", {
				query: "example.com IANA reserved domain",
				// Default: the shared config's routing. The stub runtime has no model credentials.
				...(process.env.ACCEPTANCE_SEARCH_PROVIDER ? { provider: process.env.ACCEPTANCE_SEARCH_PROVIDER } : {}),
				workflow: "summary-review",
			});
			assert.doesNotMatch(text(result), /^Error:/m);
			assert.match(text(result), /https?:\/\//);
		});
} finally {
	for (const chat of [chatA, chatB, readOnly]) await close(chat);
	rmSync(root, { recursive: true, force: true });
}
console.log(`PASS ${results.length} checks`);
