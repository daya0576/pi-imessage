import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentManager } from "../agent.js";
import type { HeadlessExtensionsOptions } from "../headless-extensions.js";
import type { AgentReply, IncomingMessage } from "../types.js";

const controls = vi.hoisted(() => ({
	sessions: [] as {
		cwd: string;
		abort: ReturnType<typeof vi.fn>;
		releasePrompt: () => void;
		releaseAbort: () => void;
		emit: (event: Record<string, unknown>) => void;
	}[],
}));
vi.mock("../headless-extensions.js", () => ({
	createHeadlessResourceLoader: (_options: HeadlessExtensionsOptions) => ({
		reload: async () => {},
		getExtensions: () => ({ errors: [], extensions: [] }),
		getHeadlessAudit: () => ({ loaded: [], skipped: [] }),
		disposeArtifacts: () => {},
	}),
	createHeadlessSchedulerExtension: () => () => {},
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const sdk = await importOriginal<typeof CodingAgent>();
	return {
		...sdk,
		ModelRuntime: {
			create: async () => ({
				refresh: async () => {},
				hasConfiguredAuth: () => true,
				getModel: () => ({ provider: "test", id: "test" }),
			}),
		},
		SettingsManager: {
			...sdk.SettingsManager,
			create: () =>
				sdk.SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test", defaultThinkingLevel: "high" }),
		},
		createAgentSession: async (options: { sessionManager: CodingAgent.SessionManager }) => {
			const listeners = new Set<(event: Record<string, unknown>) => void>();
			let releasePrompt = () => {};
			let releaseAbort = () => {};
			const promptSettlement = new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
			const abortSettlement = new Promise<void>((resolve) => {
				releaseAbort = resolve;
			});
			const emit = (event: Record<string, unknown>) => {
				for (const listener of listeners) listener(event);
			};
			const session = {
				model: { provider: "test", id: "test" },
				thinkingLevel: "high",
				setThinkingLevel: () => {},
				bindExtensions: async () => {},
				extensionRunner: { emit: async () => {} },
				getActiveToolNames: () => ["read", "bash", "edit", "write"],
				getAllTools: () => [],
				getContextUsage: () => undefined,
				clearQueue: () => {},
				dispose: () => {},
				subscribe: (listener: (event: Record<string, unknown>) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				prompt: async () => promptSettlement,
				abort: vi.fn(async () => abortSettlement),
			};
			controls.sessions.push({
				cwd: options.sessionManager.getCwd(),
				abort: session.abort,
				releasePrompt,
				releaseAbort,
				emit,
			});
			return { session };
		},
	};
});

const root = mkdtempSync(join(tmpdir(), "agent-signal-"));
afterEach(() => {
	controls.sessions = [];
});
const message: IncomingMessage = {
	chatGuid: "chat-a",
	text: "work",
	sender: "test",
	messageType: "group",
	groupName: "test",
	replyToText: null,
	attachments: [],
	images: [],
};
const flush = async () => {
	for (let index = 0; index < 30; index++) await Promise.resolve();
};

it("cancels only its admitted isolated task, fences late output and waits for operation AND abort", async () => {
	const manager = await createAgentManager({ workingDir: root });
	const replies: AgentReply[] = [];
	const normal = manager.processMessage(message, async (reply) => {
		replies.push(reply);
	});
	await flush();
	const controller = new AbortController();
	let taskSettled = false;
	const task = manager
		.processMessage(
			message,
			async (reply) => {
				replies.push(reply);
			},
			{ sessionKey: "cron-one", signal: controller.signal }
		)
		.finally(() => {
			taskSettled = true;
		});
	const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
	await flush();
	expect(controls.sessions).toHaveLength(2);
	controller.abort();
	await flush();
	expect(controls.sessions[0].abort).not.toHaveBeenCalled();
	expect(controls.sessions[1].abort).toHaveBeenCalledOnce();
	controls.sessions[1].emit({
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "late task output" }] },
	});
	controls.sessions[1].releasePrompt();
	await flush();
	expect(taskSettled).toBe(false);
	controls.sessions[1].releaseAbort();
	await rejected;
	expect(replies).toEqual([]);
	controls.sessions[0].emit({
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "normal reply" }] },
	});
	controls.sessions[0].releasePrompt();
	await normal;
	expect(replies.filter((reply) => reply.kind === "assistant").map((reply) => reply.text)).toEqual(["normal reply"]);
	rmSync(root, { recursive: true, force: true });
});

it("rejects already-aborted work before creating a session, and never accepts normal-chat cancellation", async () => {
	const workingDir = mkdtempSync(join(tmpdir(), "agent-signal-preflight-"));
	try {
		const manager = await createAgentManager({ workingDir });
		const controller = new AbortController();
		controller.abort();
		await expect(
			manager.processMessage(message, async () => {}, { sessionKey: "cron-one", signal: controller.signal })
		).rejects.toMatchObject({ name: "AbortError" });
		await expect(
			manager.processMessage(message, async () => {}, { signal: new AbortController().signal })
		).rejects.toThrow("isolated session");
		expect(controls.sessions).toEqual([]);
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}
});
