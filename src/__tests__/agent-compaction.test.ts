import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_COMPACT_TIMEOUT_MS, createAgentManager, runWithActivityTimeout } from "../agent.js";
import { createMessagePipeline } from "../pipeline.js";
import { AgentPromptTimeoutError } from "../prompt-timeout.js";
import { createCallAgentTask } from "../tasks.js";
import { type AgentReply, type IncomingMessage, createOutgoingMessage, toChatContext } from "../types.js";

const control = vi.hoisted(() => ({
	foregroundWait: false,
	afterCompactionWait: false,
	creationGate: undefined as Promise<void> | undefined,
	mode: "post" as "post" | "pre" | "preventive" | "overflow" | "plain",
	sessions: [] as FakeSession[],
}));
const result = { summary: "Synthetic summary", firstKeptEntryId: "synthetic", tokensBefore: 256000 };
class FakeSession {
	model = { provider: "test", id: "synthetic", contextWindow: 272000 };
	thinkingLevel = "high";
	listeners = new Set<(event: AgentSessionEvent) => void>();
	staleListeners: ((event: AgentSessionEvent) => void)[] = [];
	continueCount = 0;
	writes = 0;
	blocked = false;
	hangCancellation = false;
	postFailure = false;
	releaseForeground = () => {};
	foregroundGate = new Promise<void>((resolve) => {
		this.releaseForeground = resolve;
	});
	compacting = false;
	outcome: "success" | "failure" | "aborted" = "success";
	release = () => {};
	gate = new Promise<void>((resolve) => {
		this.release = resolve;
	});
	agent = {
		abort: vi.fn(() => {
			this.blocked = true;
		}),
	};
	setThinkingLevel = vi.fn();
	dispose = vi.fn();
	clearQueue = vi.fn();
	getContextUsage = () => ({ tokens: control.mode === "plain" || this.prompt.mock.calls.length > 1 ? 0 : 256000 });
	subscribe = (listener: (event: AgentSessionEvent) => void) => {
		this.listeners.add(listener);
		this.staleListeners.push(listener);
		return () => this.listeners.delete(listener);
	};
	emit(event: AgentSessionEvent) {
		for (const listener of this.listeners) listener(event);
	}
	final(text = "Synthetic final") {
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "openai-responses",
				provider: "test",
				model: "synthetic",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 255641,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 255641,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
	}
	async compression(reason: "manual" | "threshold" | "overflow") {
		this.compacting = true;
		this.emit({ type: "compaction_start", reason });
		await this.gate;
		this.compacting = false;
		this.emit({
			type: "compaction_end",
			reason,
			result: this.outcome === "success" ? result : undefined,
			aborted: this.outcome === "aborted",
			willRetry: reason === "overflow" && this.outcome === "success",
			...(this.outcome === "failure" ? { errorMessage: "PRIVATE PROVIDER ERROR" } : {}),
		});
		return result;
	}
	compact = vi.fn(() => this.compression("manual"));
	abort = vi.fn(async () => {
		this.blocked = true;
		if (this.compacting) {
			if (this.hangCancellation) await this.gate;
			else {
				this.outcome = "aborted";
				this.release();
			}
		}
	});
	prompt = vi.fn(async () => {
		this.blocked = false;
		const mode = this.prompt.mock.calls.length > 1 ? "plain" : control.mode;
		if (mode === "plain") {
			this.final("Queued final");
			return;
		}
		if (mode !== "pre") this.emit({ type: "agent_start" });
		if (control.foregroundWait) await this.foregroundGate;
		if (mode === "overflow") {
			this.writes++;
			this.emit({ type: "tool_execution_start", toolName: "write", toolCallId: "synthetic-write", args: {} });
		} else if (mode !== "pre") this.final();
		if (mode === "preventive") return;
		await this.compression(mode === "overflow" ? "overflow" : "threshold");
		if (this.postFailure) throw new Error("operation timed out: synthetic provider detail");
		// SDK preflight returns to agent.prompt even after a cancelled compaction.
		if (mode === "pre" || mode === "overflow") {
			this.blocked = false;
			this.emit({ type: "agent_start" });
			if (!this.blocked) {
				this.continueCount++;
				if (control.afterCompactionWait) {
					this.emit({ type: "tool_execution_start", toolName: "write", toolCallId: "uncertain-write", args: {} });
					await new Promise<void>(() => {});
				}
				this.final();
			}
		}
	});
}
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof CodingAgent>()),
	ModelRuntime: { create: async () => ({}) },
	SettingsManager: { create: () => ({ applyOverrides() {}, getDefaultThinkingLevel: () => "high" }) },
	SessionManager: { open: () => ({}) },
	DefaultResourceLoader: class {
		async reload() {}
		getExtensions() {
			return { errors: [] };
		}
	},
	createAgentSession: async () => {
		const session = new FakeSession();
		control.sessions.push(session);
		await control.creationGate;
		return { session };
	},
}));

let root: string;
let replies: string[];
const message: IncomingMessage = {
	chatGuid: "synthetic-chat",
	sender: "test",
	text: "Synthetic request",
	messageType: "imessage",
	groupName: "",
	replyToText: null,
	attachments: [],
	images: [],
};
const receive = async (reply: AgentReply) => {
	if (reply.kind === "assistant") replies.push(reply.text);
};
beforeEach(() => {
	vi.useFakeTimers();
	root = mkdtempSync(join(tmpdir(), "compaction-routing-"));
	replies = [];
	control.mode = "post";
	control.foregroundWait = false;
	control.afterCompactionWait = false;
	control.creationGate = undefined;
	control.sessions = [];
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("production compaction routing and deadline", () => {
	it("delivers final first, survives long compression across the foreground ceiling, never replays, then takes queued input", async () => {
		control.foregroundWait = true;
		const manager = await createAgentManager({ workingDir: root });
		const first = manager.processMessage(message, receive);
		await flush();
		// Realistic foreground activity consumes 29 of the 30 foreground minutes.
		for (let turn = 0; turn < 29; turn++) {
			await vi.advanceTimersByTimeAsync(60000);
			control.sessions[0].emit({ type: "turn_start" });
		}
		control.foregroundWait = false;
		control.sessions[0].releaseForeground();
		await flush();
		const next = manager.processMessage({ ...message, text: "Later input" }, receive, { ephemeral: false });
		await vi.advanceTimersByTimeAsync(180000);
		expect(replies).toHaveLength(2);
		expect(replies[0]).toBe("Synthetic final");
		expect(control.sessions[0].abort).not.toHaveBeenCalled();
		control.mode = "plain";
		control.sessions[0].release();
		await first;
		await next;
		expect(replies[2]).toContain("接下来处理排队的新输入");
		expect(replies.filter((text) => text === "Synthetic final")).toHaveLength(1);
		expect(replies[3]).toBe("Queued final");
		expect(control.sessions[0].prompt).toHaveBeenCalledTimes(2);
	});
	it.each(["pre", "overflow"] as const)(
		"%s continues through SDK once, with no application prompt replay",
		async (mode) => {
			control.mode = mode;
			const manager = await createAgentManager({ workingDir: root });
			const pending = manager.processMessage(message, receive);
			await flush();
			control.sessions[0].release();
			await pending;
			expect(replies).toEqual([
				"开始压缩上下文，原请求等待中。",
				"压缩完成。继续原来未完成的请求。",
				"Synthetic final",
			]);
			expect(control.sessions[0].prompt).toHaveBeenCalledTimes(1);
			expect(control.sessions[0].continueCount).toBe(1);
			expect(control.sessions[0].writes).toBe(mode === "overflow" ? 1 : 0);
		}
	);
	it.each(["preventive", "manual"] as const)("%s uses exactly one ordered SDK start/end pair", async (mode) => {
		control.mode = "preventive";
		const manager = await createAgentManager({ workingDir: root });
		const pending =
			mode === "manual"
				? manager.compact(message.chatGuid, undefined, receive)
				: manager.processMessage(message, receive);
		await flush();
		await vi.advanceTimersByTimeAsync(180000);
		control.sessions[0].release();
		await pending;
		expect(replies.filter((text) => text.startsWith("开始压缩"))).toHaveLength(1);
		expect(replies.filter((text) => text.startsWith("压缩完成"))).toHaveLength(1);
		expect(control.sessions[0].compact).toHaveBeenCalledTimes(1);
		expect(control.sessions[0].abort).not.toHaveBeenCalled();
	});
	it.each(["failure", "aborted"] as const)(
		"%s pauses uncertain work, keeps accepted next input, hides provider details",
		async (outcome) => {
			control.mode = "overflow";
			const manager = await createAgentManager({ workingDir: root });
			const pending = manager.processMessage(message, receive);
			await flush();
			const session = control.sessions[0];
			session.outcome = outcome;
			const next = manager.processMessage({ ...message, text: "Next request" }, receive);
			session.release();
			await pending;
			expect(session.continueCount).toBe(0);
			expect(session.writes).toBe(1);
			expect(session.prompt.mock.calls.length).toBeLessThanOrEqual(2);
			expect(replies.join(" ")).not.toContain("PRIVATE");
			expect(replies.join(" ")).toContain("原请求已暂停");
			await next;
			expect(session.prompt).toHaveBeenCalledTimes(2);
			expect(replies).toContain("Queued final");
		}
	);
	it("bounds a hung provider without detaching; next input waits for both operation and cancellation", async () => {
		const manager = await createAgentManager({ workingDir: root });
		const pending = manager.processMessage(message, receive);
		await flush();
		const session = control.sessions[0];
		session.hangCancellation = true;
		const next = manager.processMessage({ ...message, text: "Next request" }, receive);
		await vi.advanceTimersByTimeAsync(AGENT_COMPACT_TIMEOUT_MS + 1);
		await pending;
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(manager.getRuntimeStatus().sessions).toBe(1);
		expect(replies[2]).toContain("压缩超时");
		expect(replies.join(" ")).not.toContain("已中止当前会话");
		control.mode = "plain";
		session.release();
		await next;
		expect(session.prompt).toHaveBeenCalledTimes(2);
		expect(replies.filter((text) => text.startsWith("压缩完成"))).toHaveLength(0);
		expect(replies.filter((text) => text.startsWith("取消处理已结束"))).toHaveLength(1);
		expect(replies[replies.length - 2]).toContain("不会重做");
	});
	it.each(["stop", "new"] as const)(
		"/%s cancels preflight, suppresses stale callbacks and does not resurrect work",
		async (command) => {
			control.mode = "pre";
			const manager = await createAgentManager({ workingDir: root });
			const pending = manager.processMessage(message, receive);
			await flush();
			const old = control.sessions[0];
			if (command === "stop") await manager.stop(message.chatGuid);
			else await manager.newSession(message.chatGuid);
			await pending;
			const before = replies.length;
			for (const listener of old.staleListeners)
				listener({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: true });
			await flush();
			expect(replies).toHaveLength(before);
			expect(replies).toContain("压缩已请求取消，不再继续原请求；确认结束前暂停处理。");
			expect(old.continueCount).toBe(0);
			expect(old.prompt).toHaveBeenCalledTimes(1);
		}
	);
	it("refuses /new while cancellation is unsettled, retains ownership and suppresses late completion", async () => {
		control.mode = "pre";
		const manager = await createAgentManager({ workingDir: root });
		const pending = manager.processMessage(message, receive);
		await flush();
		const old = control.sessions[0];
		old.hangCancellation = true;
		const replacement = manager.newSession(message.chatGuid);
		const rejected = expect(replacement).rejects.toThrow("取消尚未结束");
		await vi.advanceTimersByTimeAsync(10001);
		await rejected;
		expect(control.sessions).toHaveLength(1);
		expect(old.dispose).not.toHaveBeenCalled();
		old.release();
		await pending;
		await manager.newSession(message.chatGuid);
		expect(control.sessions).toHaveLength(2);
		expect(old.continueCount).toBe(0);
		expect(replies.filter((text) => text.includes("压缩完成"))).toHaveLength(0);
	});
	it("does not let a post-compaction rejection replay the completed prompt through transport retry", async () => {
		const manager = await createAgentManager({ workingDir: root });
		const task = createCallAgentTask(manager);
		const emitted = vi.fn();
		const pending = task(toChatContext(message), message, createOutgoingMessage(), emitted);
		await flush();
		control.sessions[0].postFailure = true;
		control.sessions[0].release();
		await pending;
		await vi.advanceTimersByTimeAsync(20000);
		expect(control.sessions[0].prompt).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(emitted.mock.calls)).not.toContain("synthetic provider detail");
	});
	it("fences notices at actual pipeline delivery after /new, not only at SDK callback time", async () => {
		const manager = await createAgentManager({ workingDir: root });
		const pipeline = createMessagePipeline();
		pipeline.start(createCallAgentTask(manager));
		let releaseDelivery = () => {};
		const deliveryGate = new Promise<void>((resolve) => {
			releaseDelivery = resolve;
		});
		pipeline.end(async (_chat, outgoing) => {
			await deliveryGate;
			if (outgoing.reply.type === "message") replies.push(outgoing.reply.text);
			return outgoing;
		});
		const pending = pipeline.process(message);
		await flush();
		await manager.newSession(message.chatGuid);
		releaseDelivery();
		await pending;
		// The final send had already begun; queued notices must not leak into the replacement.
		expect(replies).toEqual(["Synthetic final"]);
	});

	it("keeps lifecycle notices out of read-only summary results and propagates a failed summary", async () => {
		control.mode = "pre";
		const manager = await createAgentManager({ workingDir: root });
		const pending = manager.processMessage(message, receive, {
			sessionKey: "summary",
			readOnly: true,
			ephemeral: true,
		});
		await flush();
		control.sessions[0].outcome = "failure";
		const rejected = expect(pending).rejects.toThrow("Read-only summary paused during compaction");
		control.sessions[0].release();
		await rejected;
		expect(replies).toEqual([]);
		expect(control.sessions[0].continueCount).toBe(0);
	});

	it.each(["replacement", "stop", "new"] as const)(
		"drains delayed preflight-timeout reporting through the production pipeline with later %s",
		async (laterAction) => {
			control.mode = "pre";
			control.afterCompactionWait = true;
			const manager = await createAgentManager({ workingDir: root });
			const pipeline = createMessagePipeline();
			pipeline.start(createCallAgentTask(manager));
			let releaseDelivery = () => {};
			const deliveryGate = new Promise<void>((resolve) => {
				releaseDelivery = resolve;
			});
			pipeline.end(async (_chat, outgoing) => {
				// An earlier send has begun, but timeout reporting is still queued behind it.
				await deliveryGate;
				if (outgoing.reply.type === "message") replies.push(outgoing.reply.text);
				return outgoing;
			});
			let settled = false;
			const pending = pipeline.process(message).finally(() => {
				settled = true;
			});
			const rejected = expect(pending).rejects.toBeInstanceOf(AgentPromptTimeoutError);
			await flush();
			const old = control.sessions[0];
			old.release();
			await vi.advanceTimersByTimeAsync(120001);
			const settledBeforeDelivery = settled;
			const checkpoint = JSON.parse(readFileSync(join(root, "synthetic-chat/interrupted-prompt.json"), "utf8"));
			expect(checkpoint).toMatchObject({ reason: "idle", pendingTools: ["write"], autoReplay: false });
			if (laterAction === "stop") {
				// Even a stop with no attached session must fence pending timeout reporting.
				await manager.stop(message.chatGuid);
			} else {
				// Another manager caller can replace the detached session while transport sends wait.
				control.mode = "plain";
				await manager.processMessage({ ...message, text: "Later synthetic input" }, receive);
				expect(control.sessions).toHaveLength(2);
				if (laterAction === "new") await manager.newSession(message.chatGuid);
			}
			releaseDelivery();
			await rejected;
			await flush();
			expect(replies.filter((text) => text.includes("已中止当前会话"))).toHaveLength(
				laterAction === "replacement" ? 1 : 0
			);
			expect(settledBeforeDelivery).toBe(false);
			expect(old.prompt).toHaveBeenCalledTimes(1);
		}
	);

	it("keeps accepted input before and during repeated cancellation waits, then announces settlement once", async () => {
		control.mode = "pre";
		const manager = await createAgentManager({ workingDir: root });
		const first = manager.processMessage(message, receive);
		await flush();
		const session = control.sessions[0];
		session.hangCancellation = true;
		const before = manager.processMessage({ ...message, text: "Accepted before stop" }, receive);
		const stop = manager.stop(message.chatGuid);
		const rejected = expect(stop).rejects.toThrow("取消尚未结束");
		await vi.advanceTimersByTimeAsync(10001);
		await rejected;
		const during = manager.processMessage({ ...message, text: "Accepted during cancellation" }, receive);
		const repeated = manager.stop(message.chatGuid);
		const rejectedAgain = expect(repeated).rejects.toThrow("取消尚未结束");
		await vi.advanceTimersByTimeAsync(10001);
		await rejectedAgain;
		expect(session.prompt).toHaveBeenCalledTimes(1);
		session.release();
		await Promise.all([first, before, during]);
		expect(session.continueCount).toBe(0);
		expect(session.prompt).toHaveBeenCalledTimes(3);
		expect(replies.filter((text) => text.startsWith("取消处理已结束"))).toHaveLength(1);
		expect(replies.slice(-3)).toEqual([
			"取消处理已结束；原请求已停止，不会自动恢复。接下来处理排队的新输入。",
			"Queued final",
			"Queued final",
		]);
	});

	it("reserves /new ownership through delayed replacement and routes all accepted input to the replacement", async () => {
		control.mode = "pre";
		const manager = await createAgentManager({ workingDir: root });
		const first = manager.processMessage(message, receive);
		await flush();
		const old = control.sessions[0];
		const before = manager.processMessage({ ...message, text: "Accepted before replacement" }, receive);
		let finishCreation = () => {};
		control.creationGate = new Promise<void>((resolve) => {
			finishCreation = resolve;
		});
		const replacement = manager.newSession(message.chatGuid);
		await flush();
		expect(control.sessions).toHaveLength(2);
		const fresh = control.sessions[1];
		const during = manager.processMessage({ ...message, text: "Accepted during creation" }, receive);
		await flush();
		expect(old.prompt).toHaveBeenCalledTimes(1);
		expect(fresh.prompt).not.toHaveBeenCalled();
		control.mode = "plain";
		finishCreation();
		await Promise.all([first, replacement, before, during]);
		expect(control.sessions).toHaveLength(2);
		expect(old.continueCount).toBe(0);
		expect(fresh.dispose).not.toHaveBeenCalled();
		expect(fresh.prompt).toHaveBeenCalledTimes(2);
	});

	it("serializes simultaneous first inputs against one asynchronous session creation", async () => {
		control.mode = "plain";
		let finishCreation = () => {};
		control.creationGate = new Promise<void>((resolve) => {
			finishCreation = resolve;
		});
		const manager = await createAgentManager({ workingDir: root });
		const first = manager.processMessage(message, receive);
		const second = manager.processMessage(message, receive);
		await flush();
		expect(control.sessions).toHaveLength(1);
		finishCreation();
		await Promise.all([first, second]);
		expect(control.sessions[0].prompt).toHaveBeenCalledTimes(2);
	});

	it.each(["stop", "new"] as const)(
		"fences already-emitted tool starts and ends at delivery after /%s",
		async (command) => {
			const manager = await createAgentManager({ workingDir: root });
			const pipeline = createMessagePipeline();
			pipeline.start(createCallAgentTask(manager));
			let releaseDelivery = () => {};
			const deliveryGate = new Promise<void>((resolve) => {
				releaseDelivery = resolve;
			});
			pipeline.end(async (_chat, outgoing) => {
				await deliveryGate;
				return outgoing;
			});
			pipeline.end((_chat, outgoing) => {
				if (outgoing.reply.type === "message") replies.push(outgoing.reply.text);
				return outgoing;
			});
			const pending = pipeline.process(message);
			await flush();
			const session = control.sessions[0];
			session.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "synthetic-read", args: {} });
			session.emit({
				type: "tool_execution_end",
				toolName: "read",
				toolCallId: "synthetic-read",
				result: { content: [{ type: "text", text: "Synthetic tool result" }] },
				isError: false,
			});
			await flush();
			if (command === "stop") {
				await manager.stop(message.chatGuid);
				// Cancellation notices are also stale after a later stop advances the generation.
				await manager.stop(message.chatGuid);
			} else await manager.newSession(message.chatGuid);
			releaseDelivery();
			await pending;
			expect(replies).toEqual([]);
		}
	);

	it("suspends only foreground clocks, not the dedicated absolute compaction deadline", async () => {
		let finish = () => {};
		let phase = (_active: boolean) => {};
		const timeout = vi.fn();
		const pending = runWithActivityTimeout(
			async (_activity, setPhase) => {
				phase = setPhase;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
			},
			timeout,
			120000,
			200000,
			600000
		);
		await vi.advanceTimersByTimeAsync(100000);
		phase(true);
		await vi.advanceTimersByTimeAsync(300000);
		phase(false);
		await vi.advanceTimersByTimeAsync(90000);
		expect(timeout).not.toHaveBeenCalled();
		finish();
		await pending;
	});
});
