import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { loadWorkspaceExtensions } from "../src/extensions/workspace.ts";
import { startService } from "../src/main.ts";

// #33: native web boundaries, conversation-local cached results and errors; no live network or paid search.
it("searches and fetches through native tools without sharing cached results across chats", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-web-"));
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	try {
		const modules = join(directory, "extensions", "fixture");
		await mkdir(modules, { recursive: true });
		await writeFile(join(modules, "value.txt"), "private fixture v1");
		await writeFile(join(modules, "config.json"), JSON.stringify({ value: "config-v1" }));
		await writeFile(
			join(modules, "index.ts"),
			`
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
module.exports = async ({ workingDir, config, Type, defineExtension, defineTool, section }) => {
  const value = config.value + ":" + await readFile(join(workingDir, "extensions/fixture/value.txt"), "utf8");
  return defineExtension({ name: "personal-fixture", sections: [section("personal_fixture", () => value)], tools: [defineTool({
    name: "personal_echo", description: "Domain-neutral fixture", parameters: Type.Object({ text: Type.String() }), replay: "safe",
    async execute(args) { return { content: [{ type: "text", text: value + ":" + args.text }] }; }
  })] });
};
`,
		);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({
				chatAllowlist: { whitelist: ["*"], blacklist: [] },
			}),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("BRAVE_API_KEY", "fixture-key");
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, options) => {
			if (String(url).startsWith("https://api.search.brave.com/")) {
				expect(options?.headers).toEqual({ "X-Subscription-Token": "fixture-key" });
				expect(new URL(String(url)).searchParams.get("q")).toBe("fixture query");
				return Response.json({
					web: {
						results: [
							{ title: "Fixture", url: "https://example.test/article", description: "source snippet" },
						],
					},
				});
			}
			expect(String(url)).toBe("https://example.test/article");
			return new Response(
				"<html><head><title>Fixture</title></head><body><article><h1>Fixture article</h1><p>Readable source text with enough content to be retained by the parser.</p></article></body></html>",
				{ headers: { "content-type": "text/html" } },
			);
		});
		vi.stubGlobal("fetch", fetch);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		agent = await startService({
			workingDir: directory,
			agentDir: join(directory, "agent"),
			runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
			send: vi.fn(),
			sendAttachment: vi.fn(),
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "fixture query" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("get_search_results", { query: "fixture query" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(
					JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")),
				).toContain("source snippet");
				return fauxAssistantMessage(fauxToolCall("fetch_content", { url: "https://example.test/article" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Readable source text");
				return fauxAssistantMessage("Web answer");
			},
			fauxAssistantMessage(fauxToolCall("get_search_results", { query: "fixture query" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(
					JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")),
				).toContain("No saved result");
				return fauxAssistantMessage(fauxToolCall("fetch_content", { url: "file:///etc/passwd" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
					isError: true,
				});
				return fauxAssistantMessage("Invalid URL rejected");
			},
		]);
		for (const chatGuid of ["first", "second"]) {
			const result = await (await agent.submit({ chatGuid, guid: "same-guid", text: "Use web tools" })).wait(
				BACKGROUND_CONTEXT,
			);
			expect(result.status).toBe("done");
		}
		expect(fetch).toHaveBeenCalledTimes(2);
		// Generic workspace code receives pinned primitives, not an SDK ExtensionAPI shim.
		for (const version of ["v1", "v2"]) {
			if (version === "v2") {
				await writeFile(join(modules, "value.txt"), "private fixture v2");
				await writeFile(join(modules, "config.json"), JSON.stringify({ value: "config-v2" }));
				const source = await readFile(join(modules, "index.ts"), "utf8");
				await writeFile(join(modules, "index.ts"), source.replace("args.text", "args.text.toUpperCase()"));
			}
			faux.setResponses([
				...(version === "v2"
					? [fauxAssistantMessage(fauxToolCall("reload_extensions", {}), { stopReason: "toolUse" })]
					: []),
				fauxAssistantMessage(fauxToolCall("personal_echo", { text: "hello" }), { stopReason: "toolUse" }),
				(context) => {
					expect(
						JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")),
					).toContain(`config-${version}:private fixture ${version}:${version === "v2" ? "HELLO" : "hello"}`);
					return fauxAssistantMessage("Personal tool completed");
				},
			]);
			expect(
				(
					await (
						await agent.submit({
							chatGuid: "first",
							guid: `personal-${version}`,
							text: "Use fixture personal tool",
						})
					).wait(BACKGROUND_CONTEXT)
				).status,
			).toBe("done");
		}
		const validSource = await readFile(join(modules, "index.ts"), "utf8");
		await writeFile(join(modules, "index.ts"), "syntax error !");
		await expect(agent.command({ chatGuid: "first", guid: "bad-reload", text: "/reload" })).rejects.toThrow();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("personal_echo", { text: "hello" }), { stopReason: "toolUse" }),
			(context) => {
				expect(
					JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")),
				).toContain("config-v2:private fixture v2:HELLO");
				return fauxAssistantMessage("Old definition survived");
			},
		]);
		await (
			await agent.submit({ chatGuid: "first", guid: "after-bad-reload", text: "Use the old tool" })
		).wait(BACKGROUND_CONTEXT);
		await writeFile(join(modules, "index.ts"), validSource);
		const duplicate = join(directory, "extensions", "duplicate");
		await mkdir(duplicate);
		await writeFile(join(duplicate, "index.ts"), validSource);
		await writeFile(join(duplicate, "config.json"), "{}");
		await expect(loadWorkspaceExtensions(directory)).rejects.toThrow("Duplicate");
		await rm(duplicate, { recursive: true });
		await rm(modules, { recursive: true });
		await agent.command({ chatGuid: "first", guid: "remove-personal", text: "/reload" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("personal_echo", { text: "hello" }), { stopReason: "toolUse" }),
			(context) => {
				expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
					isError: true,
				});
				return fauxAssistantMessage("Removed tool is unavailable");
			},
		]);
		await (await agent.submit({ chatGuid: "first", guid: "after-remove", text: "Check removed tool" })).wait(
			BACKGROUND_CONTEXT,
		);
	} finally {
		await agent?.close();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await rm(directory, { recursive: true, force: true });
	}
});
