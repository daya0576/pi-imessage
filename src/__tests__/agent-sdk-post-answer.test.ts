/** Real installed SDK lifecycle + production manager/transport; provider, usage and delay are simulated. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type Model, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentManager } from "../agent.js";
import { createIMessageBot } from "../imessage.js";
import { createAsyncQueue } from "../queue.js";
import { createSelfEchoFilter } from "../self-echo.js";
import type { MessageSender } from "../send.js";
import type { ChatStore } from "../store.js";
import type { IncomingMessage } from "../types.js";

const control = vi.hoisted(() => ({
	root: "",
	session: undefined as AgentSession | undefined,
	gate: Promise.resolve(),
	calls: 0,
	events: [] as string[],
}));
const model: Model<"openai-responses"> = {
	id: "synthetic",
	name: "Synthetic offline model",
	api: "openai-responses",
	provider: "synthetic",
	baseUrl: "https://invalid.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 272000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function response(text: string, input: number): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const sdk = await importOriginal<typeof CodingAgent>();
	return {
		...sdk,
		getAgentDir: () => control.root,
		ModelRuntime: {
			create: async () => {
				const runtime = await sdk.ModelRuntime.create({
					authPath: join(control.root, "auth.json"),
					modelsPath: null,
					modelsStorePath: join(control.root, "models-store.json"),
					refreshOnCreate: false,
				});
				vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
				vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "synthetic-not-a-credential" } });
				return runtime;
			},
		},
		SettingsManager: {
			inMemory: sdk.SettingsManager.inMemory,
			create: () =>
				sdk.SettingsManager.inMemory({
					defaultThinkingLevel: "high",
					// CLI selectors must not hide the service's built-in tools.
					defaultTools: ["+tool_search", "+codemode"],
					packages: [],
					retry: { enabled: false },
					compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 128 },
				}),
		},
		DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
			constructor(options: NonNullable<ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]>) {
				super({
					...options,
					systemPrompt: "Synthetic offline test; no tools or memory.",
					extensionFactories: [
						...(options.extensionFactories ?? []),
						{
							name: "synthetic-compaction",
							factory: (pi) => {
								pi.on("session_before_compact", async (event) => {
									await control.gate;
									return {
										compaction: {
											summary: "Synthetic summary",
											firstKeptEntryId: event.preparation.firstKeptEntryId,
											tokensBefore: event.preparation.tokensBefore,
										},
									};
								});
							},
						},
					],
				});
			}
		},
		createAgentSession: async (options: CreateAgentSessionOptions) => {
			const history = sdk.SessionManager.inMemory(control.root);
			for (let index = 0; index < 4; index++) {
				history.appendMessage({
					role: "user",
					content: `Synthetic history ${index}. ${"Example. ".repeat(100)}`,
					timestamp: Date.now() - 2000,
				});
				history.appendMessage(response("Acknowledged synthetic example.", 100));
			}
			const created = await sdk.createAgentSession({ ...options, sessionManager: history, model });
			expect(created.session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "bash", "edit", "write", "load_memory"])
			);
			control.session = created.session;
			created.session.agent.streamFunction = () => {
				const stream = createAssistantMessageEventStream();
				const first = ++control.calls === 1;
				stream.push({
					type: "done",
					reason: "stop",
					message: response(first ? "Synthetic final" : "Queued final", first ? 256000 : 100),
				});
				return stream;
			};
			created.session.subscribe((event) => control.events.push(event.type));
			vi.spyOn(created.session, "prompt");
			vi.spyOn(created.session, "abort");
			return created;
		},
	};
});
afterEach(() => {
	control.session?.dispose();
	vi.useRealTimers();
	rmSync(control.root, { recursive: true, force: true });
});
it("sends final once, survives actual SDK post-answer compaction beyond 120s, and takes queued transport input", async () => {
	vi.useFakeTimers();
	control.root = mkdtempSync(join(tmpdir(), "sdk-post-answer-"));
	control.calls = 0;
	control.events = [];
	let release = () => {};
	control.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const manager = await createAgentManager({ workingDir: control.root });
	const queue = createAsyncQueue<IncomingMessage>();
	const sent: string[] = [];
	const bot = createIMessageBot({
		queue,
		agent: manager,
		echoFilter: createSelfEchoFilter(),
		sender: {
			sendMessage: async (_chat: string, text: string) => {
				sent.push(text);
			},
		} as unknown as MessageSender,
		store: { archiveImages: async () => [], log: async () => {} } as unknown as ChatStore,
		digestLogger: { log: () => {}, close: () => {} },
		getSettings: () => ({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
	});
	const message: IncomingMessage = {
		chatGuid: "synthetic-sdk-chat",
		sender: "test",
		text: "Synthetic request",
		messageType: "imessage",
		groupName: "",
		replyToText: null,
		attachments: [],
		images: [],
	};
	bot.start();
	try {
		queue.push(message);
		await vi.waitFor(() => expect(control.events).toContain("compaction_start"));
		expect(control.events.indexOf("compaction_start")).toBeGreaterThan(control.events.indexOf("agent_end"));
		// Compaction narration is suppressed; only the real final reply is sent.
		expect(sent).toEqual(["Synthetic final"]);
		queue.push({ ...message, text: "Later synthetic input" });
		await vi.advanceTimersByTimeAsync(180000);
		expect(control.session?.abort).not.toHaveBeenCalled();
		expect(control.session?.prompt).toHaveBeenCalledTimes(1);
		release();
		await vi.waitFor(() => expect(sent).toContain("Queued final"));
		expect(sent).toEqual(["Synthetic final", "Queued final"]);
		expect(control.calls).toBe(2);
		expect(control.session?.prompt).toHaveBeenCalledTimes(2);
	} finally {
		release();
		bot.stop();
	}
});
