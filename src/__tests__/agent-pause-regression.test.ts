import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
type SessionView = {
	thinkingLevel: string;
	setThinkingLevel: ReturnType<typeof vi.fn<(level: string, options?: { persist: boolean }) => void>>;
};
const fake = vi.hoisted(() => ({
	sessions: [] as SessionView[],
	options: [] as { tools?: string[] }[],
	hang: false,
	heartbeat: false,
	modelErrors: [] as string[],
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		ModelRuntime: {
			create: async () => ({
				refresh: async () => {},
				hasConfiguredAuth: () => true,
				getModel: () => ({ provider: "test", id: "test", contextWindow: 272000 }),
			}),
		},
		SettingsManager: {
			create: () => ({
				getDefaultThinkingLevel: () => "high",
				getDefaultProvider: () => "test",
				getDefaultModel: () => "test",
				applyOverrides: () => {},
			}),
		},
		DefaultResourceLoader: class {
			async reload() {}
			getExtensions() {
				return { errors: [] };
			}
		},
		SessionManager: { open: () => ({ buildSessionContext: () => ({ messages: [] }) }) },
		createAgentSession: async (options: { tools?: string[] }) => {
			fake.options.push(options);
			const listeners = new Set<(event: Record<string, unknown>) => void>();
			const session = {
				thinkingLevel: "high",
				model: { provider: "test", id: "test", contextWindow: 272000 },
				setThinkingLevel: vi.fn((level: string, _options?: { persist: boolean }): void => {
					session.thinkingLevel = level;
				}),
				setModel: async () => {},
				dispose: vi.fn(),
				subscribe: (fn: (event: Record<string, unknown>) => void) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
				getContextUsage: () => undefined,
				getSessionStats: () => ({ userMessages: 0, tokens: { input: 0, output: 0 } }),
				clearQueue: vi.fn(),
				abort: vi.fn(async () => {
					for (const fn of listeners)
						fn({
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "aborted",
								content: [{ type: "text", text: "LATE INVALID COMPLETION" }],
							},
						});
				}),
				prompt: vi.fn(async () => {
					if (fake.modelErrors.length) {
						for (const errorMessage of fake.modelErrors)
							for (const fn of listeners)
								fn({
									type: "message_end",
									message: { role: "assistant", stopReason: "error", errorMessage, content: [] },
								});
						for (const fn of listeners)
							fn({
								type: "message_end",
								message: {
									role: "assistant",
									stopReason: "stop",
									content: [{ type: "text", text: "continued successfully" }],
								},
							});
						return;
					}
					for (const fn of listeners)
						fn({ type: "tool_execution_start", toolName: "write", toolCallId: "unknown-write", args: {} });
					if (fake.heartbeat)
						setInterval(() => {
							for (const fn of listeners) fn({ type: "message_update" });
						}, 60_000);
					if (fake.hang) return new Promise(() => {});
				}),
			};
			fake.sessions.push(session);
			return { session };
		},
	};
});
import { type AgentManager, createAgentManager } from "../agent.js";
import { writeChatThinking } from "../chat-thinking.js";
import { AgentPromptTimeoutError } from "../prompt-timeout.js";
import { createCallAgentTask } from "../tasks.js";
import { type AgentReply, type IncomingMessage, createOutgoingMessage, toChatContext } from "../types.js";
let root: string;
const msg = (chatGuid = "chat-a"): IncomingMessage => ({
	chatGuid,
	text: "authorized task",
	sender: "test",
	messageType: "group",
	groupName: "test",
	replyToText: null,
	attachments: [],
	images: [],
});
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pause-regression-"));
	fake.sessions = [];
	fake.options = [];
	fake.hang = false;
	fake.heartbeat = false;
	fake.modelErrors = [];
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});
describe("agent pause regression", () => {
	it.each(["idle", "max_duration"] as const)(
		"%s: stays silent, saves uncertain checkpoint, suppresses late abort output",
		async (kind) => {
			vi.useFakeTimers();
			fake.hang = true;
			fake.heartbeat = kind === "max_duration";
			const manager = await createAgentManager({ workingDir: root });
			const replies: AgentReply[] = [];
			const p = manager.processMessage(msg(), async (r) => {
				replies.push(r);
			});
			const rejected = expect(p).rejects.toBeInstanceOf(AgentPromptTimeoutError);
			// Idle threshold, rather than waiting a real two minutes.
			await vi.advanceTimersByTimeAsync(kind === "idle" ? 120001 : 1800001);
			await rejected;
			expect(replies.filter((r) => r.kind === "assistant")).toHaveLength(0);
			expect(JSON.stringify(replies)).not.toContain("LATE INVALID COMPLETION");
			const checkpoint = JSON.parse(readFileSync(join(root, "chat-a/interrupted-prompt.json"), "utf8"));
			expect(checkpoint).toMatchObject({
				reason: kind,
				pendingTools: ["write"],
				toolOutcomesMayBeUnknown: true,
				autoReplay: false,
			});
			expect(manager.getRuntimeStatus().activePrompts).toBe(0);
		}
	);
	it("keeps repeated model timeouts silent and delivers the later successful response", async () => {
		fake.modelErrors = ["Request timed out.", "Request timed out."];
		const manager = await createAgentManager({ workingDir: root });
		const replies: AgentReply[] = [];
		await manager.processMessage(msg(), async (reply) => {
			replies.push(reply);
		});
		expect(replies.filter((reply) => reply.kind === "assistant").map((reply) => reply.text)).toEqual([
			"continued successfully",
		]);
	});
	it("does not replay a timed-out user task through the transport retry wrapper", async () => {
		const processMessage = vi.fn(async () => {
			throw new AgentPromptTimeoutError("idle", 120000);
		});
		const task = createCallAgentTask({ processMessage } as unknown as AgentManager);
		await expect(task(toChatContext(msg()), msg(), createOutgoingMessage(), vi.fn())).rejects.toBeInstanceOf(
			AgentPromptTimeoutError
		);
		expect(processMessage).toHaveBeenCalledTimes(1);
	});
	it("applies max on create/reload/new only to the selected chat", async () => {
		const manager = await createAgentManager({ workingDir: root });
		writeChatThinking(root, "chat-a", "max");
		await manager.processMessage(msg(), async () => {});
		await manager.processMessage(msg("chat-b"), async () => {});
		expect(fake.sessions.map((s) => s.thinkingLevel)).toEqual(["max", "high"]);
		await manager.reload("chat-a");
		expect(fake.sessions[0].thinkingLevel).toBe("max");
		await manager.newSession("chat-a");
		expect(fake.sessions[2].thinkingLevel).toBe("max");
		for (const s of fake.sessions)
			for (const args of s.setThinkingLevel.mock.calls) expect(args[1]).toEqual({ persist: false });
	});
	it("read-only completion has an explicit read-only tool allowlist and cannot reuse writable sessions", async () => {
		const manager = await createAgentManager({ workingDir: root });
		await manager.processMessage(msg(), async () => {}, { sessionKey: "completion", readOnly: true });
		expect(fake.options[0].tools).toEqual(["read"]);
		await expect(manager.processMessage(msg(), async () => {}, { sessionKey: "completion" })).rejects.toThrow(
			"Cannot change tool permissions"
		);
		await expect(manager.processMessage(msg(), async () => {}, { readOnly: true })).rejects.toThrow(
			"requires an isolated session"
		);
	});
});
