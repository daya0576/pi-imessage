/** Installed pi-goal-x through the production manager; only the model stream is simulated. */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentManager } from "../agent.js";
import type { IncomingMessage } from "../types.js";

const installed = join(homedir(), ".pi/agent/npm/node_modules/pi-goal-x");
const control = vi.hoisted(() => ({ root: "", sessions: [] as AgentSession[], hang: false }));

function reply(model: { api: string; provider: string; id: string }, content: AssistantMessage["content"]) {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const sdk = await importOriginal<typeof CodingAgent>();
	return {
		...sdk,
		getAgentDir: () => join(control.root, "agent"),
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
		createAgentSession: async (options: CreateAgentSessionOptions) => {
			const created = await sdk.createAgentSession(options);
			created.session.agent.streamFunction = (model, context, options) => {
				// pi-goal-x appends a goal/context snapshot after the checkpoint, so script on the whole context.
				const seen = JSON.stringify(context.messages);
				const called = (name: string) =>
					context.messages.some(
						(entry) =>
							entry.role === "assistant" && entry.content.some((part) => part.type === "toolCall" && part.name === name)
					);
				const stream = createAssistantMessageEventStream();
				if (control.hang) {
					options?.signal?.addEventListener(
						"abort",
						() =>
							stream.push({
								type: "done",
								reason: "stop",
								message: reply(model, [{ type: "text", text: "Late aborted output" }]),
							}),
						{ once: true }
					);
					return stream;
				}
				const message =
					seen.includes("Start a goal") && !called("create_goal")
						? reply(model, [
								{
									type: "toolCall",
									id: "create",
									name: "create_goal",
									arguments: { objective: "Synthetic objective" },
								},
							])
						: seen.includes("pi_goal_continuation") && !called("update_goal")
							? reply(model, [
									{ type: "text", text: "Goal step" },
									{
										type: "toolCall",
										id: "pause",
										name: "update_goal",
										arguments: { status: "paused", reason: "Synthetic stop" },
									},
								])
							: reply(model, [{ type: "text", text: "Plain reply" }]);
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				return stream;
			};
			vi.spyOn(created.session, "sendCustomMessage");
			control.sessions.push(created.session);
			return created;
		},
	};
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const session of control.sessions) session.dispose();
	control.sessions = [];
	control.hang = false;
	rmSync(control.root, { recursive: true, force: true });
});

it.skipIf(!existsSync(installed))(
	"runs the installed pi-goal-x checkpoint as a queued chat turn with a per-chat pool",
	async () => {
		control.root = mkdtempSync(join(tmpdir(), "goal-extension-"));
		const agentDir = join(control.root, "agent");
		mkdirSync(join(agentDir, "npm/node_modules"), { recursive: true });
		symlinkSync(installed, join(agentDir, "npm/node_modules/pi-goal-x"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-goal-x"] }));
		vi.stubEnv("PI_GOAL_GLOBAL_SETTINGS_FILE", join(control.root, "goal-settings.json"));
		const delivered: string[] = [];
		const manager = await createAgentManager({
			workingDir: control.root,
			deliverGoalReply: async (chatGuid, agentReply) => {
				if (agentReply.kind === "assistant") delivered.push(`${chatGuid}: ${agentReply.text}`);
			},
		});
		const message = (chatGuid: string, text: string): IncomingMessage => ({
			chatGuid,
			sender: "test",
			text,
			messageType: "imessage",
			groupName: "",
			replyToText: null,
			attachments: [],
			images: [],
		});
		const replies: string[] = [];
		let transportPending = true;
		await manager.processMessage(message("chat-a", "Start a goal"), async () => {}, {
			hasQueuedInput: () => transportPending,
		});
		await manager.processMessage(message("chat-b", "Hello"), async (agentReply) => {
			if (agentReply.kind === "assistant") replies.push(agentReply.text);
		});

		// Accepted transport input takes priority even before it enters the SDK queue.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(delivered).toEqual([]);
		transportPending = false;
		// The checkpoint is claimed after the user turn and replied through the host subscription.
		await vi.waitFor(() => expect(delivered).toEqual(["chat-a: Goal step"]));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(delivered).toEqual(["chat-a: Goal step"]);
		expect(replies).toEqual(["Plain reply"]);
		const [chatA, chatB] = control.sessions;
		expect(chatA.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(chatB.sendCustomMessage).not.toHaveBeenCalled();

		const pool = (chatGuid: string) =>
			readdirSync(join(control.root, chatGuid, "goals")).filter((name) => name.startsWith("active_goal_"));
		expect(pool("chat-a")).toHaveLength(1);
		expect(pool("chat-b")).toEqual([]);
		expect(existsSync(join(control.root, ".pi/goals"))).toBe(false);
	},
	30000
);

it.skipIf(!existsSync(installed))(
	"migrates a legacy paused goal and runs native resume/clear without reimport or double continuation",
	async () => {
		control.root = mkdtempSync(join(tmpdir(), "goal-migration-"));
		const agentDir = join(control.root, "agent");
		mkdirSync(join(agentDir, "npm/node_modules"), { recursive: true });
		symlinkSync(installed, join(agentDir, "npm/node_modules/pi-goal-x"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-goal-x"] }));
		vi.stubEnv("PI_GOAL_GLOBAL_SETTINGS_FILE", join(control.root, "goal-settings.json"));
		mkdirSync(join(control.root, "chat-a"));
		const legacyPath = join(control.root, "chat-a", "goal.json");
		const legacy = JSON.stringify({
			version: 1,
			chatGuid: "chat-a",
			generation: "00000000-0000-0000-0000-000000000000",
			objective: "Legacy objective",
			state: "paused",
			progress: "Verified checkpoint",
			reason: "Needs explicit resume",
			evidence: "Old receipt",
			turns: 1,
			limit: 4,
		});
		writeFileSync(legacyPath, legacy);
		const delivered: string[] = [];
		const manager = await createAgentManager({
			workingDir: control.root,
			deliverGoalReply: async (_chat, result) => {
				if (result.kind === "assistant") delivered.push(result.text);
			},
		});
		const command = async (text: string) => {
			const replies: string[] = [];
			await manager.processMessage(
				{
					chatGuid: "chat-a",
					sender: "test",
					text,
					messageType: "imessage",
					groupName: "",
					replyToText: null,
					attachments: [],
					images: [],
				},
				async (result) => {
					if (result.kind === "assistant") replies.push(result.text);
				}
			);
			return replies.join("\n");
		};
		expect(await command("/goal status")).toMatch(/Legacy objective/);
		expect(await command("/goal status")).toMatch(/paused/i);
		control.hang = true;
		const running = command("Hang ordinary turn");
		await vi.waitFor(() => expect(manager.getRuntimeStatus().activePrompts).toBe(1));
		// Inspection is native and immediate while busy; pause cancels instead of waiting behind the turn.
		expect(await command("/goal status")).toMatch(/Legacy objective/);
		expect(await command("/goal pause")).toMatch(/paused|already/i);
		expect(await running).toBe("");
		control.hang = false;
		expect(delivered).toEqual([]);
		expect(await command("/goal resume")).toMatch(/resumed/i);
		// /stop fences an idle-but-armed native goal too, not just an active model operation.
		await manager.stop("chat-a");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(delivered).toEqual([]);
		expect(await command("/goal status")).toMatch(/paused/i);
		expect(await command("/goal resume")).toMatch(/resumed/i);
		await vi.waitFor(() => expect(delivered).toEqual(["Goal step"]));
		await manager.stop("chat-a");
		expect(await command("/goal status")).toMatch(/paused/i);
		expect(await command("/goal clear")).toMatch(/archived/i);
		await manager.newSession("chat-a");
		expect(await command("/goal status")).not.toMatch(/Legacy objective/);
		expect(delivered).toEqual(["Goal step"]);
		expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
	},
	30000
);
