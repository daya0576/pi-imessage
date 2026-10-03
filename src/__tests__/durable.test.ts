import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { isDurableChat, openDurableChat } from "../durable.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable chat", () => {
	it("selects chats from the env list", () => {
		expect(isDurableChat("a", "a, b")).toBe(true);
		expect(isDurableChat("c", "a,b")).toBe(false);
		expect(isDurableChat("c", "*")).toBe(true);
		expect(isDurableChat("c", "")).toBe(false);
	});

	it("answers once per request ID across a reopen", async () => {
		const chatDir = mkdtempSync(join(tmpdir(), "pi-durable-"));
		dirs.push(chatDir);
		const faux = fauxProvider({ models: [{ id: "stub" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const open = () =>
			openDurableChat({
				models,
				chatDir,
				cwd: chatDir,
				systemPrompt: () => "Be brief.",
				agent: async () => ({ model: { provider: faux.provider.id, modelId: "stub" } }),
			});
		faux.setResponses([fauxAssistantMessage("hi")]);

		const first = await open();
		const answer = await first.prompt([{ type: "text", text: "hello" }], "messages:1");
		expect(answer?.content).toEqual([{ type: "text", text: "hi" }]);
		await first.close();

		// A transport replay after restart reattaches instead of calling the model again.
		const second = await open();
		const replay = await second.prompt([{ type: "text", text: "hello" }], "messages:1");
		expect(replay?.content).toEqual([{ type: "text", text: "hi" }]);
		expect(faux.state.callCount).toBe(1);
		await second.close();
	});
});
