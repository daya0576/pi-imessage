import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskRecord, ToolTaskInput, ToolTaskResult } from "@earendil-works/pi-durable";
import { isReplyEnabled, readSettings } from "../config/settings.ts";
import type { MessageSender } from "../transport/send.ts";
import { Chats } from "./chats.ts";
import { takeScheduledCompaction } from "./compaction.ts";
import { deliverDirect } from "./direct-send.ts";
import { argumentSummary, commandPreview, formatProgress, type ProgressEvent } from "./progress-format.ts";
import { Runs } from "./run.ts";

async function calledTool(harness: Harness, task: TaskRecord<JsonValue, JsonValue, unknown>) {
	if (task.kind !== "pi.tool") return;
	// The registered native task owns this input shape and its branded assistant ID.
	const input = task.input as ToolTaskInput;
	const entry = await harness.commit((tx) => tx.entry(input.assistant), BACKGROUND_CONTEXT);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return;
	const call = message.content.find((part) => part.type === "toolCall" && part.id === input.callId);
	return call?.type === "toolCall" ? call : undefined;
}

async function canonicalPath(path: string) {
	return realpath(path).catch(async () =>
		resolve(await realpath(dirname(path)).catch(() => dirname(path)), basename(path)),
	);
}

/** Classify metadata only; attachment reads still execute and keep their normal results/history. */
async function attachmentPath(workingDir: string, path: unknown) {
	if (typeof path !== "string") return false;
	// Match the native read tool's @, Unicode-space and home-path normalization.
	let normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~" || normalized.startsWith("~/")) normalized = resolve(homedir(), normalized.slice(2));
	if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			/* Keep malformed URLs as ordinary paths, like native read. */
		}
	}
	const root = resolve(workingDir, "attachments");
	const candidate = resolve(workingDir, normalized);
	const roots = [root, await canonicalPath(root)];
	const candidates = [candidate, await canonicalPath(candidate)];
	return roots.some((directory) =>
		candidates.some((file) => file === directory || file.startsWith(`${directory}${sep}`)),
	);
}

/** Observe native admission and settlement; Durable owns execution and recovery. */
export async function startProgress(harness: Harness, workingDir: string, sender: MessageSender) {
	// Existing live work belongs to the previous startup; do not replay historical progress.
	const seen = new Set((await harness.inspect(BACKGROUND_CONTEXT)).tasks.map(({ record }) => record.id));
	type Notice = { admittedAt: number; chatGuid?: string; request?: ProgressEvent };
	const active = new Map<number, Notice>();
	let pending = Promise.resolve();
	async function notify(task: TaskRecord<JsonValue, JsonValue, JsonValue>, notice: Notice) {
		if (task.kind === "pi.compaction" && (await takeScheduledCompaction(harness, task.id))) return;
		const settings = await readSettings(workingDir);
		if (!settings.progressMessages) return;
		const chats = (await harness.snapshot(Chats, BACKGROUND_CONTEXT))?.items ?? [];
		const runs = (await harness.snapshot(Runs, BACKGROUND_CONTEXT))?.items ?? [];
		let conversationId = task.conversationId;
		let chatGuid: string | undefined;
		const parents: string[] = [];
		while (!chatGuid) {
			chatGuid = [...chats, ...runs].find((item) => item.conversationId === conversationId)?.chatGuid;
			if (chatGuid) break;
			const conversation = await harness.commit((tx) => tx.conversation(conversationId), BACKGROUND_CONTEXT);
			if (!conversation?.owner) return; // Health and unrelated ownerless conversations stay local.
			const owner = await harness.getTask(conversation.owner.taskId, BACKGROUND_CONTEXT);
			const call = owner && (await calledTool(harness, owner));
			parents.unshift(call?.name ?? owner?.kind ?? "child");
			conversationId = conversation.owner.conversationId;
		}
		if (!isReplyEnabled(settings, chatGuid)) return;
		const tool = await calledTool(harness, task);
		if (tool?.name === "read" && (await attachmentPath(workingDir, tool.arguments.path))) return;
		const request: ProgressEvent = tool
			? {
					phase: "request",
					type: "tool",
					parents,
					name: tool.name,
					...(tool.name === "bash"
						? { commandPreview: commandPreview(tool.arguments.command) }
						: { summary: argumentSummary(tool.arguments) }),
				}
			: { phase: "request", type: "task", parents, name: task.kind };
		notice.chatGuid = chatGuid;
		notice.request = request;
		const text = formatProgress(request);
		const receipt = await deliverDirect(
			harness,
			{ chatGuid, requestId: `progress:${task.id}`, text },
			sender,
		);
		if (receipt.textStatus === "unknown") console.warn("Progress delivery unknown", task.id, chatGuid);
	}
	async function settled(task: TaskRecord<JsonValue, JsonValue, JsonValue>, notice: Notice, elapsed: number) {
		if (!notice.chatGuid || !notice.request || task.state.status !== "terminal") return;
		const settings = await readSettings(workingDir);
		if (!settings.progressMessages || !isReplyEnabled(settings, notice.chatGuid)) return;
		const outcome = task.state.outcome;
		let success = outcome.status === "completed";
		if (success && task.kind === "pi.tool" && outcome.status === "completed") {
			const result = outcome.result;
			const entryId =
				result && typeof result === "object" && "entryId" in result ? result.entryId : undefined;
			const entry =
				typeof entryId === "number"
					? await harness.commit((tx) => tx.entry(entryId as ToolTaskResult["entryId"]), BACKGROUND_CONTEXT)
					: undefined;
			const message = entry?.model?.[0];
			success = message?.role === "toolResult" && !message.isError;
		}
		const text = formatProgress({ ...notice.request, phase: "response", success, elapsedMs: elapsed });
		const receipt = await deliverDirect(
			harness,
			{
				chatGuid: notice.chatGuid,
				requestId: `progress:${task.id}:done`,
				text,
			},
			sender,
		);
		if (receipt.textStatus === "unknown")
			console.warn("Progress completion delivery unknown", task.id, notice.chatGuid);
	}
	const unsubscribe = harness.subscribeCommits(({ changes }) => {
		for (const change of changes) {
			if (change.type !== "task" || change.value.kind === "pi.generation") continue;
			const task = change.value;
			if (task.state.status === "terminal") {
				seen.delete(task.id);
				const notice = active.get(task.id);
				active.delete(task.id);
				if (notice) {
					const elapsed = performance.now() - notice.admittedAt;
					pending = pending
						.then(() => settled(task, notice, elapsed))
						.catch((error: unknown) => {
							console.warn("Progress completion notification failed", task.id, error);
						});
				}
				continue;
			}
			if (task.state.status !== "pending" || seen.has(task.id)) continue;
			seen.add(task.id);
			const notice: Notice = { admittedAt: performance.now() };
			active.set(task.id, notice);
			// The synchronous observer must not call Session APIs or block adoption.
			pending = pending
				.then(() => notify(task, notice))
				.catch((error: unknown) => {
					console.warn("Progress notification failed", task.id, error);
				});
		}
	});
	return {
		flush: () => pending,
		async close() {
			unsubscribe();
			await pending;
		},
	};
}
