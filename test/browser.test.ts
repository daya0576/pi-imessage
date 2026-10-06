import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { Chats } from "../src/agent/chats.ts";
import { createBrowser } from "../src/extensions/browser.ts";
import { startService } from "../src/main.ts";

type Call = {
	argv: string[];
	pid: number;
	ownerLock: boolean;
	cwd: string;
	home: string;
	state: string;
	inheritedTarget?: string;
	inheritedDaemon?: string;
	inheritedSecret?: string;
};

// #33 / ADR 0017: native registration, forced argv/env scope, owned lifecycle and explicit unsafe replay.
it("enforces conversation-owned browser operations and preserves only owned resources across stop and restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-browser-"));
	const agentDir = join(directory, "agent");
	await mkdir(join(agentDir, "bin"), { recursive: true });
	await copyFile(new URL("./fixtures/browser-cli.cjs", import.meta.url), join(agentDir, "bin", "pi-browser"));
	await chmod(join(agentDir, "bin", "pi-browser"), 0o700);
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
	);
	vi.stubEnv("PLAYWRIGHT_MCP_CDP_ENDPOINT", "http://outside-fixture.invalid");
	vi.stubEnv("PWTEST_DAEMON_SESSION_DIR", "/outside-fixture");
	vi.stubEnv("BROWSER_FIXTURE_SECRET", "fixture-private-env");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const options = {
		workingDir: directory,
		agentDir,
		runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
		send: vi.fn(),
		sendAttachment: vi.fn(),
	};
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	async function calls(id: number) {
		const [hash] = await readdir(join(directory, "browser"));
		return (await readFile(join(directory, "browser", hash, String(id), "cwd", "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Call);
	}
	try {
		agent = await startService(options);
		for (const chatGuid of ["first", "second"]) {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("browser", { action: "open", url: "https://example.test" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("browser", { action: "snapshot" }), { stopReason: "toolUse" }),
				(context) => {
					expect(
						JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")),
					).toContain("[ref=e1]");
					return fauxAssistantMessage(
						fauxToolCall("browser", { action: "fill", ref: "e1", text: "--profile=/outside literal" }),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage(fauxToolCall("browser", { action: "open", profile: "/outside" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
						isError: true,
					});
					return fauxAssistantMessage(fauxToolCall("browser", { action: "goto", url: "file:///outside" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
						isError: true,
					});
					return fauxAssistantMessage("Browser boundary checked");
				},
			]);
			expect(
				(
					await (
						await agent.submit({ chatGuid, guid: "browser", text: "Use browser" })
					).wait(BACKGROUND_CONTEXT)
				).status,
			).toBe("done");
		}
		const [first, second] = (await agent.harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items ?? [];
		const a = await calls(first.conversationId);
		const b = await calls(second.conversationId);
		expect(a[0].home).not.toBe(b[0].home);
		expect(a[0].cwd).not.toBe(b[0].cwd);
		expect(a[0].state).not.toBe(b[0].state);
		for (const row of [...a, ...b]) {
			expect(row.argv[0]).toBe("-s=owned");
			expect(row.inheritedTarget).toBeUndefined();
			expect(row.inheritedDaemon).toBeUndefined();
			expect(row.inheritedSecret).toBeUndefined();
		}
		expect(a.find((row) => row.argv[1] === "fill")?.argv).toEqual([
			"-s=owned",
			"fill",
			"--",
			"e1",
			"--profile=/outside literal",
		]);
		expect(a.filter((row) => row.argv[1] === "open")).toHaveLength(1);
		const selected = await (
			await agent.harness.conversation(first.conversationId, BACKGROUND_CONTEXT)
		)?.agent(BACKGROUND_CONTEXT);
		expect(selected?.tools.find((tool) => tool.name === "browser")).toMatchObject({
			replay: "unsafe",
			executionMode: "sequential",
		});
		await agent.command({ chatGuid: "first", guid: "stop-browser", text: "/stop" });
		expect((await calls(first.conversationId)).at(-1)?.argv[1]).toBe("close");
		expect(await calls(second.conversationId)).toHaveLength(b.length);
		await agent.command({ chatGuid: "second", guid: "new-browser", text: "/new" });
		expect((await calls(second.conversationId)).at(-1)?.argv[1]).toBe("close");
		// A restart closes known scoped daemons, but does not delete profiles or replay uncertain mutations.
		await agent.close();
		expect(
			(await calls(first.conversationId))
				.filter((row) => row.argv[1] === "close")
				.every((row) => row.ownerLock),
		).toBe(true);
		agent = await startService(options);
		const browser = await createBrowser(directory, agentDir);
		await browser.run(first.conversationId, { action: "open" });
		expect((await calls(first.conversationId)).some((row) => row.argv[1] === "state-load")).toBe(true);
		expect(await readFile(join(a[0].state, "profiles", "owned", "fixture.txt"), "utf8")).toBe(
			"retained login fixture",
		);
		expect((await stat(join(a[0].state, "auth.json"))).mode & 0o777).toBe(0o600);
		await expect(
			browser.run(first.conversationId, { action: "fill", ref: "e1", text: "fixture-private-failure" }),
		).rejects.not.toThrow("fixture-private-failure");
		const abort = new AbortController();
		const running = browser.run(
			first.conversationId,
			{ action: "fill", ref: "e1", text: "fixture-wait" },
			abort.signal,
		);
		const rejected = expect(running).rejects.toThrow("do not repeat blindly");
		await vi.waitFor(async () =>
			expect((await calls(first.conversationId)).at(-1)?.argv).toContain("fixture-wait"),
		);
		const interrupted = (await calls(first.conversationId)).at(-1);
		abort.abort();
		await rejected;
		if (!interrupted) throw new Error("Missing fixture child");
		expect(() => process.kill(interrupted.pid, 0)).toThrow();
		await browser.close([first.conversationId]);
		expect(
			(await calls(first.conversationId)).filter((row) => row.argv.includes("fixture-wait")),
		).toHaveLength(1);
		// Explicitly blocked actions never cross the subprocess boundary.
		for (const action of ["attach", "list", "close-all", "kill-all", "state-load", "delete-data"]) {
			await expect(
				browser.run(first.conversationId, { action } as Parameters<typeof browser.run>[1]),
			).rejects.toThrow("Unsupported");
		}
	} finally {
		await agent?.close();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	}
}, 15000);
