/**
 * Opt-in Pi Durable execution for ordinary chats (issue #31).
 *
 * One SQLite file per chat; the chat is the Harness root conversation. Inputs
 * are submitted with a stable request ID, so a transport replay after restart
 * reattaches to the same submission instead of running it twice.
 */

import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, Models, TextContent } from "@earendil-works/pi-ai";
import {
	type AgentChange,
	AssistantEntry,
	type EntryId,
	Harness,
	createRegistry,
	defineExtension,
	section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const context = BACKGROUND_CONTEXT;

/** `PI_IMESSAGE_DURABLE_CHATS`: comma-separated chat GUIDs, or `*` for all chats. */
export function isDurableChat(chatGuid: string, list = process.env.PI_IMESSAGE_DURABLE_CHATS ?? ""): boolean {
	const chats = list.split(",").map((item) => item.trim());
	return chats.includes("*") || chats.includes(chatGuid);
}

export interface DurableChatOptions {
	models: Models;
	chatDir: string;
	cwd: string;
	systemPrompt: () => string;
	/** Agent choices for a new conversation; existing conversations keep their stored ones. */
	agent: () => Promise<AgentChange>;
}

export type DurableChat = Awaited<ReturnType<typeof openDurableChat>>;

export async function openDurableChat(options: DurableChatOptions) {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(
		defineExtension({ name: "imessage", sections: [section("imessage", () => options.systemPrompt(), { tag: false })] })
	);
	const storage = await openNodeSqliteStorage(join(options.chatDir, "durable.sqlite"));
	const harness = await Harness.open(
		storage,
		{
			models: options.models,
			registry,
			env: () => new NodeExecutionEnv({ cwd: options.cwd }),
			// Large Codex contexts exceed the WebSocket frame limit; same as the SDK path.
			settings: { stream: { transport: "sse" } },
		},
		context
	);
	const root = await harness.root(context, { agent: await options.agent() });
	harness.resume();
	// Steered inputs join the running work and settle with one shared answer.
	const delivered = new Set<EntryId>();

	return {
		/** Resolves with the answer, or undefined when another input already received it. */
		async prompt(
			content: (TextContent | ImageContent)[],
			requestId: string | undefined,
			onAdmitted?: () => void
		): Promise<AssistantMessage | undefined> {
			const submission = await root.submit({ type: "input", content, requestId, whenBusy: "steer" }, context);
			onAdmitted?.();
			const settled = await submission.wait(context);
			if (settled.type !== "input" || settled.status !== "done") throw new Error("Durable input was not answered");
			const answer = settled.answer;
			if (delivered.has(answer)) return undefined;
			delivered.add(answer);
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, answer), context);
			return entry?.model?.[0] as AssistantMessage | undefined;
		},
		stop: () => root.abort(context),
		reset: () => root.reset(undefined, context),
		configure: (change: AgentChange) => root.configure(change, context),
		close: () => harness.close(context),
	};
}
