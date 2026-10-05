import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { expect, it, vi } from "vitest";
import { Sessions } from "../src/agent/isolated.ts";
import { startService } from "../src/main.ts";
import { createServices } from "../src/scheduler/services.ts";
import { startWeb } from "../src/web/server.ts";

// #33 / ADR 0018: tasks run fresh and isolated, the chat records what was sent, and viewing has no side effects.
it("runs cron tasks fresh, records what was sent in the chat and serves read-only state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-http-"));
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	let services: Awaited<ReturnType<typeof createServices>> | undefined;
	let web: Awaited<ReturnType<typeof startWeb>> | undefined;
	try {
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
		);
		await copyFile(
			new URL("./fixtures/scheduler-service.cjs", import.meta.url),
			join(directory, "scheduler-service.cjs"),
		);
		vi.stubEnv("PI_SCHEDULER_SERVICE_PATH", join(directory, "scheduler-service.cjs"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const send = vi.fn().mockResolvedValue(undefined);
		const sendAttachment = vi.fn().mockResolvedValue(undefined);
		agent = await startService({
			workingDir: directory,
			agentDir: join(directory, "agent"),
			runtime: { models, defaults: { model: { provider: model.provider, modelId: model.id } } },
			extensions: () => [CodingTools],
			send,
			sendAttachment,
		});
		services = await createServices({ workingDir: directory, agent });
		agent.install(services.extension);
		web = await startWeb({
			workingDir: directory,
			agent,
			scheduled: services.api,
			host: "127.0.0.1",
			port: 0,
		});
		const base = `http://127.0.0.1:${web.address.port}`;
		const post = (path: string, body: unknown) =>
			fetch(base + path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		for (const path of ["/send", "/prompt"])
			expect((await post(path, { chatGuid: "chat" })).status).toBe(404);
		faux.setResponses([
			fauxAssistantMessage("Chat answer <script>unsafe</script> sk-fixturesecretkey"),
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("Chat-only private request");
				return fauxAssistantMessage("Cron answer");
			},
			(context) => {
				// A fresh conversation per run: the first run's prompt and answer are not here.
				expect(JSON.stringify(context.messages).match(/Cron-only request/g)).toHaveLength(1);
				return fauxAssistantMessage(fauxToolCall("send_message", { filePath: "/tmp/fixture-file" }), {
					stopReason: "toolUse",
				});
			},
			() => fauxAssistantMessage("Second cron answer"),
			(context) => {
				// The chat conversation records what the user saw from tasks and tools.
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain("Cron answer");
				expect(messages).toContain("/tmp/fixture-file");
				expect(messages).not.toContain("Cron-only request");
				return fauxAssistantMessage("Follow-up answer");
			},
		]);
		await (
			await agent.submit({ chatGuid: "chat", guid: "ordinary", text: "Chat-only private request" })
		).wait(BACKGROUND_CONTEXT);
		expect((await post("/cron/jobs/fixture-cron/run", {})).status).toBe(200);
		expect((await post("/cron/jobs/fixture-cron/run", {})).status).toBe(200);
		expect(sendAttachment).toHaveBeenCalledWith("chat", "/tmp/fixture-file");
		const sessions = await agent.harness.snapshot(Sessions, BACKGROUND_CONTEXT);
		expect(sessions?.items).toHaveLength(2);
		await agent.deliver();
		await (await agent.submit({ chatGuid: "chat", guid: "follow-up", text: "Tell me more" })).wait(
			BACKGROUND_CONTEXT,
		);
		await agent.deliver();
		expect(send.mock.calls.map(([, text]) => text)).toEqual([
			expect.stringContaining("Chat answer"),
			"Cron answer",
			"Second cron answer",
			"Follow-up answer",
		]);
		for (const path of [
			"/",
			"/chat/data",
			"/settings",
			"/scheduled",
			"/scheduled/data",
			"/memory",
			"/logs",
			"/automation",
		])
			expect((await fetch(base + path)).status).toBe(200);
		const chatState = await (await fetch(`${base}/chat/data`)).json();
		const conversationId = chatState.chats.items[0].conversationId;
		const history = await (await fetch(`${base}/?conversationId=${conversationId}`)).text();
		expect(history).toContain("&lt;script&gt;");
		expect(history).not.toContain("sk-fixturesecretkey");
		expect(faux.state.callCount).toBe(5);
		const reminder = await (
			await post("/reminders", {
				chatGuid: "chat",
				text: "fixture reminder",
				scheduledAt: "2099-01-01T00:00:00+08:00",
			})
		).json();
		expect(reminder.reminder.id).toBe("fixture-reminder");
		expect((await fetch(`${base}/reminders/${reminder.reminder.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await (await post("/cron/jobs/fixture-cron/enabled", { enabled: false })).json()).enabled).toBe(
			false,
		);
		expect(faux.state.callCount).toBe(5);
		faux.setResponses([
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).not.toContain("chat-steer");
				expect(messages).not.toContain("reply-delivery");
				const tools = context.messages
					.filter((message) => message.role === "system")
					.flatMap((message) => message.toolsAdded ?? []);
				expect(tools.map((tool) => tool.name)).toEqual(["read"]);
				return fauxAssistantMessage("Read-only summary");
			},
			fauxAssistantMessage(fauxToolCall("schedule_task", { when: "1h", prompt: "Fixture delayed work" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(
					JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")),
				).toContain("fixture-task");
				return fauxAssistantMessage("Scheduled");
			},
		]);
		const background = await agent.task({
			chatGuid: "chat",
			prompt: "Summarize registered files",
			label: "background",
			scope: "background",
			readOnly: true,
			deliver: false,
			requestId: "summary",
		});
		expect(await agent.result(background)).toBe("Read-only summary");
		await agent.deliver();
		expect(send.mock.calls.map(([, text]) => text)).not.toContain("Read-only summary");
		await (await agent.submit({ chatGuid: "chat", guid: "schedule", text: "Schedule fixture work" })).wait(
			BACKGROUND_CONTEXT,
		);
		expect(faux.state.callCount).toBe(8);
		faux.setResponses([fauxAssistantMessage("OK")]);
		expect((await fetch(`${base}/health/model`)).status).toBe(200);
		expect(faux.state.callCount).toBe(9);
	} finally {
		await web?.close();
		await services?.close();
		await agent?.close();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	}
});
