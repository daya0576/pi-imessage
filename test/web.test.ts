import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { startService } from "../src/main.ts";

// #33: native web boundaries, conversation-local cached results and errors; no live network or paid search.
it("searches and fetches through native tools without sharing cached results across chats", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-web-"));
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	try {
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
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
	} finally {
		await agent?.close();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		await rm(directory, { recursive: true, force: true });
	}
});
