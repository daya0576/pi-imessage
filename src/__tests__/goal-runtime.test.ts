import type * as FileSystem from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CodingAgent from "@earendil-works/pi-coding-agent";
import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_IDLE_TIMEOUT_MS, createAgentManager } from "../agent.js";
import { createGoalController, parseGoalCommand } from "../goal.js";
import { createIMessageBot } from "../imessage.js";
import { createAsyncQueue } from "../queue.js";
import { createSelfEchoFilter } from "../self-echo.js";
import type { MessageSender } from "../send.js";
import type { ChatStore } from "../store.js";
import type { IncomingMessage } from "../types.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof CodingAgent.DefaultResourceLoader>[0];

const control = vi.hoisted(() => ({
	sessions: [] as FakeSession[],
	calls: [] as string[],
	failNextGoalCheckpoint: false,
}));
vi.mock("node:fs", async (importOriginal) => {
	const filesystem = await importOriginal<typeof FileSystem>();
	return {
		...filesystem,
		writeFileSync: vi.fn<typeof filesystem.writeFileSync>((path, data, options) => {
			if (control.failNextGoalCheckpoint && String(path).includes("/goal.json.")) {
				// One failure is enough: a blind idle retry would start a forbidden SDK turn.
				control.failNextGoalCheckpoint = false;
				throw new Error("fictional checkpoint write failure");
			}
			return filesystem.writeFileSync(path, data, options);
		}),
	};
});
function gate() {
	let release = () => {};
	let reject = (_error: Error) => {};
	const promise = new Promise<void>((resolve, rejectPromise) => {
		release = resolve;
		reject = rejectPromise;
	});
	return { promise, release, reject };
}
class FakeLoader {
	tools = new Map<string, ToolDefinition>();
	toolGate?: () => ToolCallEventResult | undefined;
	constructor(readonly options: DefaultResourceLoaderOptions) {}
	async reload() {
		expect(this.options.noExtensions).toBe(true);
		const api = {
			registerTool: (tool: ToolDefinition) => this.tools.set(tool.name, tool),
			on: (event: string, handler: () => ToolCallEventResult | undefined) => {
				if (event === "tool_call") this.toolGate = handler;
			},
		} as unknown as ExtensionAPI;
		for (const extension of this.options.extensionFactories ?? [])
			await (typeof extension === "function" ? extension : extension.factory)(api);
	}
	getExtensions() {
		return { errors: [] };
	}
	async tool(name: string, params: Record<string, unknown> = {}) {
		const blocked = this.toolGate?.();
		if (blocked?.block) throw new Error(blocked.reason);
		const tool = this.tools.get(name);
		if (!tool) throw new Error("tool not registered");
		return tool.execute("fictional-call", params, undefined, undefined, {} as ExtensionContext);
	}
}
class FakeSession {
	listeners = new Set<(event: AgentSessionEvent) => void>();
	stale: ((event: AgentSessionEvent) => void)[] = [];
	turns: ReturnType<typeof gate>[] = [];
	model = { provider: "mock", id: "fictional", contextWindow: 100000 };
	pendingMessageCount = 0;
	agent = { abort: vi.fn() };
	abort = vi.fn(async () => {}); // Abort can return before the underlying SDK callback settles.
	clearQueue = vi.fn();
	dispose = vi.fn();
	setThinkingLevel = vi.fn();
	setModel = vi.fn(async () => {});
	getContextUsage = () => ({ tokens: 0, percent: 0, contextWindow: 100000 });
	getSessionStats = () => ({ userMessages: this.turns.length, tokens: { input: 0, output: 0 } });
	constructor(readonly loader: FakeLoader) {}
	subscribe(listener: (event: AgentSessionEvent) => void) {
		this.listeners.add(listener);
		this.stale.push(listener);
		return () => this.listeners.delete(listener);
	}
	emit(event: AgentSessionEvent) {
		for (const listener of this.listeners) listener(event);
	}
	final(text = "fictional SDK reply") {
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "openai-responses",
				provider: "mock",
				model: "fictional",
				stopReason: "stop",
				timestamp: 0,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
	}
	prompt = vi.fn(async (text: string) => {
		control.calls.push(text);
		this.emit({ type: "agent_start" });
		const pending = gate();
		this.turns.push(pending);
		await pending.promise;
		this.final();
	});
}
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof CodingAgent>()),
	getAgentDir: () => "/fictional-sdk-no-auth",
	ModelRuntime: {
		create: async () => ({
			refresh: async () => {},
			hasConfiguredAuth: () => true,
			getModel: () => ({ provider: "mock", id: "fictional" }),
		}),
	},
	SettingsManager: {
		create: () => ({
			applyOverrides() {},
			getDefaultThinkingLevel: () => "high",
			getDefaultProvider: () => "mock",
			getDefaultModel: () => "fictional",
		}),
	},
	SessionManager: { open: () => ({ buildSessionContext: () => ({ messages: [] }) }) },
	DefaultResourceLoader: vi.fn((options: DefaultResourceLoaderOptions) => new FakeLoader(options)),
	createAgentSession: async ({ resourceLoader }: { resourceLoader: FakeLoader }) => {
		const session = new FakeSession(resourceLoader);
		control.sessions.push(session);
		return { session };
	},
}));
let root: string;
const cleanups: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	root = mkdtempSync(join(tmpdir(), "goal-fictional-"));
	control.sessions = [];
	control.calls = [];
	control.failNextGoalCheckpoint = false;
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const session of control.sessions) for (const turn of session.turns) turn.release();
	await flush();
	vi.clearAllTimers();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});
const flush = () => vi.advanceTimersByTimeAsync(0);
const incoming = (text: string, chatGuid = "fictional-group"): IncomingMessage => ({
	chatGuid,
	text,
	sender: "alice",
	messageType: "group",
	groupName: "Fictional",
	replyToText: null,
	attachments: [],
	images: [],
});
async function fixture(start = true) {
	const goals = createGoalController(root);
	const agent = await createAgentManager({ workingDir: root, goals });
	const queue = createAsyncQueue<IncomingMessage>();
	const sendMessage = vi.fn(async (_chatGuid: string, _text: string) => {});
	const log = vi.fn(async () => {});
	const echoFilter = createSelfEchoFilter();
	const settings = { chatAllowlist: { whitelist: ["*"], blacklist: [] as string[] } };
	const bot = createIMessageBot({
		queue,
		goals,
		agent,
		echoFilter,
		sender: { sendMessage } as unknown as MessageSender,
		store: { archiveImages: async () => [], log } as unknown as ChatStore,
		getSettings: () => settings,
		digestLogger: { log: vi.fn(), close() {} },
	});
	if (start) bot.start();
	cleanups.push(() => bot.stop());
	const send = async (text: string, chatGuid?: string) => {
		queue.push(incoming(text, chatGuid));
		await flush();
	};
	const texts = () => sendMessage.mock.calls.map(([, text]) => text).join("\n");
	return { goals, agent, bot, send, texts, sendMessage, log, settings, echoFilter };
}
async function report(session: FakeSession, state: string, text: string, evidence = "") {
	const inspected = await session.loader.tool("goal_inspect");
	const content = inspected.content[0];
	if (content.type !== "text") throw new Error("Unexpected fixture tool output");
	const generation: unknown = JSON.parse(content.text).generation;
	await session.loader.tool("goal_report", { generation, state, text, evidence });
}
function finish(session: FakeSession) {
	session.turns[session.turns.length - 1].release();
}

describe("goal transport + ownership queue + controlled SDK extension", () => {
	it("executes a two-step goal, serves busy status without a prompt, prioritizes real input, delivers and records verified completion", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 在虚构目录完成两步检查");
		const session = control.sessions[0];
		expect(session.turns).toHaveLength(1);
		await report(session, "progress", "第一步完成");
		await fixtureBot.send("/goal status");
		expect(fixtureBot.texts()).toContain("状态：执行中\n进展：第一步完成");
		expect(session.turns).toHaveLength(1);
		await fixtureBot.send("真实用户插入输入");
		finish(session);
		await flush();
		expect(control.calls[1]).toContain("真实用户插入输入");
		await expect(report(session, "completed", "不允许普通轮次更新", "evidence")).rejects.toThrow("有效目标");
		finish(session);
		await flush();
		expect(control.calls[2]).toContain("用户目标（JSON 字符串）");
		await expect(report(session, "completed", "完成", "  ")).rejects.toThrow("验证依据");
		await report(session, "completed", "第二步完成", "虚构检查输出：2/2 通过（报告）");
		finish(session);
		await flush();
		expect(fixtureBot.texts()).toContain("已完成（模型报告）");
		expect(fixtureBot.texts()).toContain("虚构检查输出：2/2 通过");
		expect(fixtureBot.log).toHaveBeenCalledWith(
			"fictional-group",
			expect.objectContaining({ fromAgent: true, groupName: "Fictional", text: expect.stringContaining("第二步完成") })
		);
		expect(fixtureBot.echoFilter.isEcho("fictional-group", "fictional SDK reply")).toBe(true);
		expect(statSync(join(root, "fictional-group", "goal.json")).mode & 0o777).toBe(0o600);
		expect(session.turns).toHaveLength(3);
	});

	it.each(["/stop", "/goal pause", "/goal clear", "/new", "/goal 替换目标", "/reload"])(
		"%s fences late tools/output, and never silently resumes old work",
		async (command) => {
			const fixtureBot = await fixture();
			await fixtureBot.send("/goal 原目标");
			const old = control.sessions[0];
			await report(old, "progress", "曾经的进展");
			await fixtureBot.send(command); // cancellation waits for actual SDK settlement
			await expect(report(old, "completed", "过期完成", "过期依据")).rejects.toThrow();
			old.final("late callback must not send");
			finish(old);
			await flush();
			expect(fixtureBot.texts()).not.toContain("late callback must not send");
			expect(fixtureBot.goals.status("fictional-group")).not.toContain("过期完成");
			if (command === "/goal 替换目标") {
				expect(fixtureBot.goals.status("fictional-group")).toContain("替换目标");
				finish(control.sessions[control.sessions.length - 1]);
				await flush();
			} else {
				await fixtureBot.send("普通消息不是恢复授权");
				const current = control.sessions[control.sessions.length - 1];
				finish(current);
				await flush();
				expect(control.calls.filter((text) => text.includes("用户目标（JSON 字符串）"))).toHaveLength(1);
			}
		}
	);

	it("admits later controls and other chats while replacement cancellation is unsettled, without resurrecting it", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 原目标");
		const old = control.sessions[0];
		const stop = vi.spyOn(fixtureBot.agent, "stop");
		await fixtureBot.send("/goal 等待取消的替换目标");
		await fixtureBot.send("/goal status");
		expect(fixtureBot.texts()).toContain("目标：等待取消的替换目标\n状态：等待执行");
		await fixtureBot.send("/goal pause");
		expect(fixtureBot.goals.status("fictional-group")).toContain("已暂停");
		await fixtureBot.send("/new");
		await fixtureBot.send("/goal clear");
		await fixtureBot.send("/stop");
		expect(stop).toHaveBeenCalledTimes(4);
		await fixtureBot.send("/goal", "other-chat");
		expect(fixtureBot.sendMessage).toHaveBeenCalledWith(
			"other-chat",
			expect.stringContaining("当前没有目标"),
			undefined
		);
		await fixtureBot.send("/goal 另一聊天的工作", "other-chat");
		expect(control.sessions).toHaveLength(2);
		expect(old.turns).toHaveLength(1);
		await report(control.sessions[1], "blocked", "缺少虚构输入");
		finish(control.sessions[1]);
		old.final("late replacement output");
		finish(old);
		await flush();
		expect(fixtureBot.goals.status("fictional-group")).toContain("当前没有目标");
		expect(fixtureBot.texts()).not.toContain("late replacement output");
		expect(fixtureBot.texts()).not.toContain("目标已创建；将在排队用户输入之后执行。\n目标：等待取消的替换目标");
		expect(control.calls).toHaveLength(2);
	});

	it.each(["/goal resume", "/goal 替换后恢复"])(
		"retains the %s wake during delayed failed-turn status delivery",
		async (command) => {
			const fixtureBot = await fixture();
			await fixtureBot.send("/goal 恢复唤醒检查");
			const failedSession = control.sessions[0];
			const delivery = gate();
			let failureStatusPending = false;
			fixtureBot.sendMessage.mockImplementation(async (_chatGuid, text) => {
				if (text.includes("状态：已暂停")) {
					failureStatusPending = true;
					await delivery.promise;
				}
			});
			failedSession.turns[0].reject(new Error("fictional SDK failure before completion"));
			await flush();
			expect(failureStatusPending).toBe(true);
			expect(fixtureBot.goals.status("fictional-group")).toContain("已暂停");
			await fixtureBot.send(command);
			expect(fixtureBot.goals.status("fictional-group")).toContain("等待执行");
			expect(control.calls).toHaveLength(1);
			delivery.release();
			await flush();
			// No extra message/status query is allowed to accidentally wake the drain.
			expect(control.calls).toHaveLength(2);
			const resumed = control.sessions[control.sessions.length - 1];
			await report(resumed, "completed", "恢复后的检查完成", "虚构验收依据");
			finish(resumed);
			await flush();
			expect(fixtureBot.goals.status("fictional-group")).toContain("已完成");
			expect(control.calls).toHaveLength(2);
		}
	);

	it("does not hold command admission behind sender settlement", async () => {
		const fixtureBot = await fixture();
		const delivery = gate();
		fixtureBot.sendMessage.mockImplementationOnce(async () => delivery.promise);
		await fixtureBot.send("/goal");
		await fixtureBot.send("/goal", "other-chat");
		expect(fixtureBot.sendMessage).toHaveBeenCalledTimes(2);
		expect(fixtureBot.log).toHaveBeenCalledWith("other-chat", expect.objectContaining({ fromAgent: true }));
		delivery.release();
		await flush();
	});

	it("yields an autonomous admission behind another caller to later queued input, and rejects a prior run generation", async () => {
		const fixtureBot = await fixture();
		const first = fixtureBot.agent.processMessage(incoming("另一个正常调用占用会话"), async () => {});
		await flush();
		const session = control.sessions[0];
		// Resume does not abort the other normal caller; it waits in the existing ownership chain.
		fixtureBot.goals.command("fictional-group", "等待队列目标");
		fixtureBot.goals.pause("fictional-group", "测试暂停");
		await fixtureBot.send("/goal resume");
		await fixtureBot.send("排队用户优先");
		expect(fixtureBot.goals.status("fictional-group")).toContain("等待执行");
		finish(session);
		await first;
		await flush();
		expect(control.calls[1]).toContain("排队用户优先");
		finish(session);
		await flush();
		const oldGeneration: unknown = JSON.parse(
			readFileSync(join(root, "fictional-group", "goal.json"), "utf8")
		).generation;
		await report(session, "progress", "第一轮推进");
		finish(session);
		await flush();
		await expect(
			session.loader.tool("goal_report", {
				generation: oldGeneration,
				state: "completed",
				text: "旧轮次误报",
				evidence: "old evidence",
			})
		).rejects.toThrow("过期轮次");
		finish(session);
		await flush();
		expect(fixtureBot.goals.status("fictional-group")).not.toContain("旧轮次误报");
	});

	it("blocks on the first missing permission, resumes exactly once, then pauses on no new progress", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 需要用户许可的虚构任务");
		const session = control.sessions[0];
		await report(session, "blocked", "缺少许可，未执行写入");
		expect(session.loader.toolGate?.()?.block).toBe(true);
		finish(session);
		await flush();
		expect(fixtureBot.goals.status("fictional-group")).toContain("已阻塞");
		await fixtureBot.send("/goal resume");
		await fixtureBot.send("/goal resume");
		expect(session.turns).toHaveLength(2);
		finish(session);
		await flush();
		expect(fixtureBot.texts()).toContain("没有报告新进展");
		expect(session.turns).toHaveLength(2);
	});

	it("exhausts the fixed cumulative budget without renewal", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 四轮预算");
		const session = control.sessions[0];
		for (let step = 1; step <= 4; step++) {
			await report(session, "progress", `步骤 ${step}`);
			finish(session);
			await flush();
		}
		await fixtureBot.send("/goal resume");
		expect(fixtureBot.texts()).toContain("预算已耗尽");
		expect(session.turns).toHaveLength(4);
	});

	it("retains SDK ownership on a goal timeout; explicit resume cannot race an unknown tool outcome", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 未知操作");
		const session = control.sessions[0];
		await vi.advanceTimersByTimeAsync(AGENT_IDLE_TIMEOUT_MS + 1);
		expect(fixtureBot.goals.status("fictional-group")).toContain("已暂停");
		expect(fixtureBot.agent.getRuntimeStatus().sessionSettings[0].awaitingCancellation).toBe(true);
		await fixtureBot.send("/goal resume");
		expect(session.turns).toHaveLength(1);
		await expect(report(session, "progress", "late")).rejects.toThrow();
		finish(session);
		await flush();
		expect(session.turns).toHaveLength(2);
		finish(session);
		await flush();
	});

	it("pauses goals on an intervening ordinary timeout and retains ownership until BOTH prompt and abort settle", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 两步虚构目标");
		const session = control.sessions[0];
		await report(session, "progress", "第一步完成");
		await fixtureBot.send("插入的普通工作");
		finish(session);
		await flush();
		expect(control.calls[1]).toContain("插入的普通工作");
		const cancellation = gate();
		session.abort.mockImplementationOnce(async () => cancellation.promise);
		await vi.advanceTimersByTimeAsync(AGENT_IDLE_TIMEOUT_MS + 1);
		expect(fixtureBot.goals.status("fictional-group")).toContain("聊天轮次超时");
		expect(fixtureBot.agent.getRuntimeStatus().sessionSettings[0].awaitingCancellation).toBe(true);
		expect(JSON.parse(readFileSync(join(root, "fictional-group", "interrupted-prompt.json"), "utf8")).autoReplay).toBe(
			false
		);
		await fixtureBot.send("/goal status");
		expect(fixtureBot.texts()).toContain("状态：已暂停");
		await fixtureBot.send("/goal resume");
		await fixtureBot.send("/goal resume");
		await fixtureBot.send("未知结果之后排队的真实输入");
		session.final("late ordinary output");
		finish(session);
		await flush();
		expect(control.calls).toHaveLength(2); // SDK prompt settled, abort still unresolved.
		expect(control.sessions).toHaveLength(1); // No competing context.jsonl writer.
		expect(fixtureBot.texts()).not.toContain("late ordinary output");
		cancellation.release();
		await flush();
		expect(control.calls[2]).toContain("未知结果之后排队的真实输入");
		finish(session);
		await flush();
		expect(control.calls[3]).toContain("用户目标（JSON 字符串）");
		await report(session, "blocked", "核对未知操作结果需要用户输入");
		finish(session);
		await flush();
		expect(session.turns).toHaveLength(4);
	});

	it("fences a failed initial run checkpoint without an idle retry, even after storage recovers", async () => {
		const fixtureBot = await fixture();
		fixtureBot.goals.command("fictional-group", "检查点失败前的目标");
		const runOne = vi.spyOn(fixtureBot.goals, "runOne");
		control.failNextGoalCheckpoint = true;
		await fixtureBot.send("/goal status"); // Registers chat metadata and wakes the transport idle loop.
		expect(control.failNextGoalCheckpoint).toBe(false);
		expect(runOne).toHaveBeenCalledTimes(1);
		await expect(runOne.mock.results[0].value).resolves.toBe(false);
		expect(control.calls).toHaveLength(0);
		await fixtureBot.send("/goal status"); // A later wake must not retry either.
		expect(fixtureBot.texts()).toContain("状态：已暂停");
		expect(fixtureBot.texts()).toContain("检查点写入失败");
		expect(fixtureBot.log).toHaveBeenCalledWith(
			"fictional-group",
			expect.objectContaining({ fromAgent: true, text: expect.stringContaining("检查点写入失败") })
		);
		await fixtureBot.send("普通消息不恢复检查点失败的目标");
		const session = control.sessions[0];
		finish(session);
		await flush();
		expect(control.calls).toHaveLength(1);
		expect(fixtureBot.goals.status("fictional-group")).toContain("轮数：0/4");
		await fixtureBot.send("/goal resume");
		expect(control.calls).toHaveLength(2);
		await report(session, "blocked", "需要核对存储故障前的结果");
		finish(session);
		await flush();
	});

	it("pauses a ready goal immediately on an ordinary compaction failure even when the SDK resolves normally", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 两步目标压缩回归");
		const session = control.sessions[0];
		await report(session, "progress", "第一步完成");
		await fixtureBot.send("穿插的普通输入");
		finish(session);
		await flush();
		expect(control.calls[1]).toContain("穿插的普通输入");
		session.emit({ type: "compaction_start", reason: "threshold" });
		session.emit({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "fictional ordinary compaction failure",
			result: undefined,
		});
		await fixtureBot.send("/goal status");
		expect(fixtureBot.texts()).toContain("聊天轮次压缩未成功");
		expect(fixtureBot.goals.status("fictional-group")).toContain("已暂停");
		session.final("late ordinary compaction output");
		finish(session); // Resolves, not rejects: the catch/timeout path cannot rescue this case.
		await flush();
		expect(control.calls).toHaveLength(2);
		expect(fixtureBot.texts()).not.toContain("late ordinary compaction output");
		await fixtureBot.send("之后的普通输入不是恢复授权");
		finish(session);
		await flush();
		expect(control.calls).toHaveLength(3);
		await fixtureBot.send("/goal resume");
		await fixtureBot.send("/goal resume");
		expect(control.calls).toHaveLength(4);
		await report(session, "completed", "第二步完成", "虚构检查结果 2/2");
		finish(session);
		await flush();
		expect(fixtureBot.texts()).toContain("已完成（模型报告）");
	});

	it("does not commit reported completion after failed compaction or continue after a send failure", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 压缩失败检查");
		const session = control.sessions[0];
		await report(session, "completed", "声称完成", "仅模型报告依据");
		session.emit({ type: "compaction_start", reason: "threshold" });
		session.emit({
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "fictional failure",
			result: undefined,
		});
		finish(session);
		await flush();
		expect(fixtureBot.goals.status("fictional-group")).toContain("已暂停");
		await fixtureBot.send("/goal resume");
		await report(session, "progress", "新进展");
		fixtureBot.sendMessage.mockRejectedValueOnce(new Error("fictional sender failure"));
		finish(session);
		await flush();
		expect(fixtureBot.goals.status("fictional-group")).toContain("发送失败");
		expect(session.turns).toHaveLength(2);
	});

	it("keeps chat goals out of ephemeral/read-only sessions and separates chats", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal A目标");
		await fixtureBot.send("/goal", "other-chat");
		expect(fixtureBot.texts()).toContain("当前没有目标");
		const isolated = fixtureBot.agent.processMessage(incoming("虚构汇总"), async () => {}, {
			sessionKey: "summary",
			ephemeral: true,
			readOnly: true,
		});
		await flush();
		const session = control.sessions[1];
		expect(session.loader.tools.has("goal_inspect")).toBe(false);
		expect(session.loader.tools.has("goal_report")).toBe(false);
		finish(session);
		await isolated;
		finish(control.sessions[0]);
		await flush();
	});

	it("does not run on a disabled worker and gates blacklisted commands and subsequent goal output", async () => {
		const fixtureBot = await fixture(false);
		await fixtureBot.send("/goal 禁止启动");
		expect(control.sessions).toHaveLength(0);
		fixtureBot.settings.chatAllowlist.blacklist.push("fictional-group");
		fixtureBot.bot.start();
		await flush();
		expect(control.sessions).toHaveLength(0);
		fixtureBot.settings.chatAllowlist.blacklist = [];
		await fixtureBot.send("/goal 可以启动");
		const session = control.sessions[0];
		fixtureBot.settings.chatAllowlist.blacklist.push("fictional-group");
		session.final("disabled output");
		finish(session);
		await flush();
		expect(fixtureBot.texts()).not.toContain("disabled output");
		expect(fixtureBot.goals.status("fictional-group")).toContain("已暂停");
	});

	it("restores an in-flight checkpoint paused, never replays, and rejects corrupt state/unsafe paths and budget syntax", async () => {
		const fixtureBot = await fixture();
		await fixtureBot.send("/goal 重启检查");
		const restored = createGoalController(root);
		expect(restored.status("fictional-group")).toContain("进程重启");
		expect(
			await restored.runOne(
				incoming(""),
				fixtureBot.agent,
				() => true,
				() => false,
				async () => {}
			)
		).toBe(false);
		expect(control.sessions[0].turns).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(root, "fictional-group", "goal.json"), "utf8")).state).toBe("paused");
		writeFileSync(join(root, "fictional-group", "goal.json"), "corrupt");
		expect(() => createGoalController(root).command("fictional-group", "禁止覆盖损坏状态")).toThrow("状态损坏");
		expect(() => restored.command("../escape", "目标")).toThrow("聊天标识");
		symlinkSync(join(root, "missing"), join(root, "unsafe-chat"));
		expect(() => restored.command("unsafe-chat", "目标")).toThrow("符号链接");
		expect(() => parseGoalCommand("/goal --turns 999 objective")).toThrow("预算参数");
		expect(() => parseGoalCommand("/goal status extra")).toThrow("用法");
		expect(() => parseGoalCommand(`/goal ${"长".repeat(2001)}`)).toThrow("最多 2000");
		expect(parseGoalCommand("/goalpost")).toBeUndefined();
		// Stop the original fixture without allowing it to overwrite this corruption fixture.
		fixtureBot.bot.stop();
		finish(control.sessions[0]);
		await flush();
	});
});
