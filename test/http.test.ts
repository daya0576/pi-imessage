import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTask } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { chatConversation } from "../src/agent/chats.ts";
import { Sessions } from "../src/agent/health.ts";
import { Schedules } from "../src/agent/scheduling.ts";
import { startService } from "../src/main.ts";
import { createReadCache } from "../src/web/cache.ts";
import { startWeb } from "../src/web/server.ts";

// #33 / ADR 0019: retired scheduling surfaces are gone; immediate sends and read-only views remain.
it("records immediate tool sends in chat and serves state without scheduling entry points", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-http-"));
	let agent: Awaited<ReturnType<typeof startService>> | undefined;
	let web: Awaited<ReturnType<typeof startWeb>> | undefined;
	try {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// Coalesce readers, retry an invalidated in-flight result, and never retain failures or oversized values.
		const cache = createReadCache(2, 128);
		let revision = 0;
		const stale = Promise.withResolvers<string>();
		const load = vi
			.fn()
			.mockImplementationOnce(() => stale.promise)
			.mockResolvedValue("new");
		const pending = [cache.read("shared", () => revision, load), cache.read("shared", () => revision, load)];
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
		revision++;
		stale.resolve("old");
		expect(await Promise.all(pending)).toEqual(["new", "new"]);
		expect(load).toHaveBeenCalledTimes(2);
		await cache.read("shared", () => revision, load);
		expect(load).toHaveBeenCalledTimes(2);
		const failed = vi.fn().mockRejectedValueOnce(new Error("fixture failure")).mockResolvedValue("ok");
		await expect(cache.read("failure", () => revision, failed)).rejects.toThrow("fixture failure");
		expect(await cache.read("failure", () => revision, failed)).toBe("ok");
		const large = vi.fn().mockResolvedValue("x".repeat(256));
		await cache.read("large", () => revision, large);
		await cache.read("large", () => revision, large);
		expect(large).toHaveBeenCalledTimes(2);
		const bounded = createReadCache(2);
		const first = vi.fn().mockResolvedValue("first");
		await bounded.read("first", () => 0, first);
		await bounded.read(
			"second",
			() => 0,
			async () => "second",
		);
		await bounded.read(
			"third",
			() => 0,
			async () => "third",
		);
		await bounded.read("first", () => 0, first);
		expect(first).toHaveBeenCalledTimes(2);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ chatAllowlist: { whitelist: ["*"], blacklist: [] } }),
		);
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
			send,
			sendAttachment,
		});
		web = await startWeb({ workingDir: directory, agent, host: "127.0.0.1", port: 0 });
		const base = `http://127.0.0.1:${web.address.port}`;
		for (const path of [
			"/send",
			"/prompt",
			"/reminders",
			"/reminders/old",
			"/cron/jobs/old/run",
			"/cron/jobs/old/enabled",
			"/automation",
			"/automation/data",
		]) {
			for (const method of ["GET", "POST", "DELETE"])
				expect((await fetch(base + path, { method })).status, `${method} ${path}`).toBe(404);
		}
		// #33 / ADR 0032: reading native schedules does not start model work.
		expect((await agent.harness.snapshot(Schedules, BACKGROUND_CONTEXT))?.items).toHaveLength(1);
		const scheduled = await (await fetch(`${base}/scheduled/data`)).json();
		expect(scheduled.jobs).toHaveLength(1);
		expect(scheduled.jobs[0]).toMatchObject({
			id: "compact-chats",
			intervalMs: 21600000,
			timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
			phase: "sleep",
			runs: [],
		});
		expect(scheduled.recent).toEqual([]);
		expect((await fetch(`${base}/scheduled`)).status).toBe(200);
		for (const method of ["POST", "DELETE"])
			expect((await fetch(`${base}/scheduled/data`, { method })).status).toBe(404);
		expect(faux.state.callCount).toBe(0);
		faux.setResponses([
			(context) => {
				const tools = context.messages
					.filter((message) => message.role === "system")
					.flatMap((message) => message.toolsAdded ?? [])
					.map((tool) => tool.name);
				expect(tools).toContain("send_message");
				for (const name of [
					"schedule_task",
					"list_scheduled_tasks",
					"cancel_scheduled_task",
					"watch_background",
				])
					expect(tools).not.toContain(name);
				return fauxAssistantMessage(
					fauxToolCall("send_message", { text: "Extra message", filePath: "/tmp/fixture-file" }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Chat answer <script>unsafe</script> sk-fixturesecretkey"),
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain("[sent message, sent]");
				expect(messages).toContain("Extra message");
				expect(messages).toContain("[sent file, sent] /tmp/fixture-file");
				return fauxAssistantMessage("Follow-up answer");
			},
		]);
		await (await agent.submit({ chatGuid: "chat", guid: "ordinary", text: "Send this file" })).wait(
			BACKGROUND_CONTEXT,
		);
		await agent.deliver();
		expect(sendAttachment).toHaveBeenCalledWith("chat", "/tmp/fixture-file");
		await (await agent.submit({ chatGuid: "chat", guid: "follow-up", text: "Tell me more" })).wait(
			BACKGROUND_CONTEXT,
		);
		await agent.deliver();
		expect(send.mock.calls.map(([, text]) => text)).toEqual([
			"Extra message",
			expect.stringContaining("Chat answer"),
			"Follow-up answer",
		]);
		for (const path of ["/", "/chat/data", "/settings", "/memory", "/logs"])
			expect((await fetch(base + path)).status).toBe(200);
		const chatState = await (await fetch(`${base}/chat/data`)).json();
		const conversationId = chatState.chats.items[0].conversationId;
		// The overview batches display-only history; full native APIs remain unchanged.
		const other = await chatConversation(
			agent.harness,
			{ model: { provider: model.provider, modelId: model.id } },
			"other",
		);
		await other.submit(
			{
				type: "write",
				entry: {
					kind: "pi.user",
					model: [
						{
							role: "user",
							content: [
								{ type: "text", text: "Other chat" },
								{ type: "image", data: "unused-image-payload", mimeType: "image/png" },
							],
							timestamp: 123,
						},
					],
					data: {
						legacy: true,
						original: {
							senderName: "Fixture sender",
							groupName: "Fixture group",
							text: "unused-original-copy",
						},
					},
				},
			},
			BACKGROUND_CONTEXT,
		);
		const windowChat = await chatConversation(
			agent.harness,
			{ model: { provider: model.provider, modelId: model.id } },
			"iMessage;+;window",
		);
		for (let index = 0; index < 20; index++) {
			await windowChat.submit(
				{
					type: "write",
					entry: {
						kind: "pi.user",
						model: [{ role: "user", content: `Window ${index}`, timestamp: 1000 + index }],
						data: { legacy: true, original: index === 0 ? { groupName: "Older group name" } : {} },
					},
				},
				BACKGROUND_CONTEXT,
			);
		}
		await windowChat.submit(
			{
				type: "write",
				entry: {
					kind: "fixture.mixed",
					model: [
						{ role: "user", content: "Too old", timestamp: 1 },
						{ ...fauxAssistantMessage("Final window"), timestamp: 1020 },
					],
					data: { legacy: true },
				},
			},
			BACKGROUND_CONTEXT,
		);
		const snapshots = vi.spyOn(agent.harness, "snapshot");
		const overviewResponse = await fetch(`${base}/chat/data?view=overview`);
		const overviewText = await overviewResponse.text();
		const overview = JSON.parse(overviewText);
		expect(overview.conversations).toHaveLength(3);
		// Chat and Tasks use the same message-activity clock, including imported histories.
		const activityTree = await (await fetch(`${base}/tasks/data`)).json();
		expect(activityTree.conversations).toContainEqual(
			expect.objectContaining({ id: windowChat.id, groupName: "Older group name" }),
		);
		expect(activityTree.conversations).toContainEqual(
			expect.objectContaining({ id: other.id, groupName: "Fixture group" }),
		);
		for (const chat of overview.conversations) {
			const conversation = activityTree.conversations.find(
				(item: { id: number }) => item.id === chat.conversationId,
			);
			expect(conversation.updatedAt).toBe(chat.updatedAt);
		}
		expect(
			overview.conversations.find((chat: { chatGuid: string }) => chat.chatGuid === "other").updatedAt,
		).toBe(123);
		expect(
			overview.conversations.find((chat: { chatGuid: string }) => chat.chatGuid === "iMessage;+;window")
				.updatedAt,
		).toBe(1020);
		for (const chat of overview.conversations)
			expect(
				chat.history.items.flatMap((entry: { model: unknown[] }) => entry.model).length,
			).toBeLessThanOrEqual(15);
		const windowOverview = overview.conversations.find(
			(chat: { conversationId: number }) => chat.conversationId === windowChat.id,
		);
		expect(
			windowOverview.history.items
				.flatMap((entry: { model: { content: string }[] }) => entry.model)
				.map((message: { content: string }) => message.content)
				.sort(),
		).toEqual([...Array.from({ length: 14 }, (_, index) => `Window ${index + 6}`), "Final window"].sort());
		expect(windowOverview.history.groupName).toBe("Older group name");
		const windowDetail = await (
			await fetch(`${base}/chat/data?conversationId=${windowChat.id}&view=display`)
		).json();
		expect(windowDetail.history.items.flatMap((entry: { model: unknown[] }) => entry.model)).toHaveLength(22);
		expect(JSON.stringify(windowDetail.history)).toContain("Too old");
		expect(overview.settings.chatAllowlist.whitelist).toEqual(["*"]);
		const recent = overview.conversations.find(
			(chat: { conversationId: number }) => chat.conversationId === conversationId,
		);
		expect(JSON.stringify(recent)).toContain("Follow-up answer");
		expect(Object.values(recent.delivery.answers)).toContain("sent");
		expect(recent).not.toHaveProperty("agent");
		expect(recent).not.toHaveProperty("live");
		for (const entry of recent.history.items)
			for (const message of entry.model) expect(["user", "assistant"]).toContain(message.role);
		expect(overviewText).not.toContain("unused-image-payload");
		expect(overviewText).not.toContain("unused-original-copy");
		expect(overviewText).not.toContain("sk-fixturesecretkey");
		expect(overviewText).toContain("[Image attachment]");
		expect(overviewText).toContain("Fixture sender");
		const root = await (await fetch(base)).text();
		const embedded = root.match(/<pre id="state">([\s\S]*?)<\/pre>/)?.[1];
		expect(embedded).toContain("conversations");
		expect(root).toContain("&lt;script&gt;");
		const uncompressed = await fetch(base, { headers: { "Accept-Encoding": "identity" } });
		const uncompressedText = await uncompressed.text();
		expect(uncompressed.headers.get("content-encoding")).toBeNull();
		expect(uncompressed.headers.get("vary")).toBe("Accept-Encoding");
		const compressed = await fetch(base, { headers: { "Accept-Encoding": "br, gzip;q=0.8" } });
		expect(compressed.headers.get("content-encoding")).toBe("gzip");
		expect(await compressed.text()).toBe(uncompressedText);
		expect(Number(compressed.headers.get("content-length"))).toBeLessThan(
			Buffer.byteLength(uncompressedText),
		);
		const refused = await fetch(base, { headers: { "Accept-Encoding": "gzip;q=0, *;q=1" } });
		expect(refused.headers.get("content-encoding")).toBeNull();
		expect(await refused.text()).toBe(uncompressedText);
		const snapshotCount = snapshots.mock.calls.length;
		await Promise.all([fetch(`${base}/chat/data?view=overview`), fetch(base)]);
		expect(snapshots).toHaveBeenCalledTimes(snapshotCount);
		const detail = await (await fetch(`${base}/chat/data?conversationId=${conversationId}`)).json();
		expect(detail).toHaveProperty("agent");
		expect(detail).toHaveProperty("live");
		const countAfterDetail = snapshots.mock.calls.length;
		const display = await (
			await fetch(`${base}/chat/data?conversationId=${conversationId}&view=display`)
		).json();
		expect(display.chat.conversationId).toBe(conversationId);
		expect(display).not.toHaveProperty("agent");
		expect(display).not.toHaveProperty("live");
		expect(snapshots).toHaveBeenCalledTimes(countAfterDetail);
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({
				chatAllowlist: { whitelist: ["*"], blacklist: [] },
				richText: { enabled: true },
			}),
		);
		expect((await (await fetch(`${base}/settings/data`)).json()).richText.enabled).toBe(true);
		const memoryDirectory = join(directory, "skills", "file-memory", "namespaces", "nested");
		await mkdir(memoryDirectory, { recursive: true });
		await writeFile(join(memoryDirectory, "fixture.jsonl"), "old");
		expect((await (await fetch(`${base}/memory/data`)).json())[0].records).toBe("old");
		await writeFile(join(memoryDirectory, "fixture.jsonl"), "new");
		expect((await (await fetch(`${base}/memory/data`)).json())[0].records).toBe("new");
		await rm(join(memoryDirectory, "fixture.jsonl"));
		expect(await (await fetch(`${base}/memory/data`)).json()).toEqual([]);
		// Memory filters and pages complete records on the server, including cross-namespace supersession.
		const facts = Array.from({ length: 45 }, (_, index) => ({
			id: `memory-${index}`,
			text: `Memory record ${String(index).padStart(2, "0")}`,
			kind: "fact",
			status: "active",
			created_at: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
			subjects: ["fixture"],
		}));
		const largeRecord = {
			id: "large-memory",
			kind: "fact",
			status: "active",
			created_at: "2026-02-01T00:00:00Z",
			text: `${"x".repeat(60000)} COMPLETE_RECORD_TAIL`,
		};
		const memoryContents = () =>
			`${[...facts, largeRecord].map((record) => JSON.stringify(record)).join("\n")}\n{"invalid":\n`;
		await writeFile(join(memoryDirectory, "fixture.jsonl"), memoryContents());
		await writeFile(
			join(directory, "skills", "file-memory", "namespaces", "secondary.jsonl"),
			[
				{
					id: "replacement",
					text: "Replacement record",
					kind: "procedure",
					status: "active",
					supersedes: "memory-0",
					created_at: "2026-01-02T00:00:00Z",
				},
				{ id: "deleted-memory", text: "Deleted record", kind: "fact", status: "deleted" },
			]
				.map((record) => JSON.stringify(record))
				.join("\n"),
		);
		const memoryView = await (await fetch(`${base}/memory/data?view=records`)).json();
		expect(memoryView).toMatchObject({
			total: 46,
			recordCount: 48,
			page: 1,
			pages: 3,
			pageSize: 20,
			invalidRecords: 1,
		});
		expect(memoryView.records).toHaveLength(20);
		expect(memoryView.records[0].text).toBe(largeRecord.text);
		expect(memoryView.namespaces).toEqual(["nested/fixture", "secondary"]);
		expect(memoryView.kinds).toEqual(["fact", "procedure"]);
		const secondPage = await (await fetch(`${base}/memory/data?view=records&page=2`)).json();
		expect(secondPage.records).toHaveLength(20);
		expect(
			secondPage.records.some((record: { id: string }) =>
				memoryView.records.some((first: { id: string }) => first.id === record.id),
			),
		).toBe(false);
		const lastPage = await (await fetch(`${base}/memory/data?view=records&page=999`)).json();
		expect(lastPage.page).toBe(3);
		expect(lastPage.records).toHaveLength(6);
		const superseded = await (
			await fetch(`${base}/memory/data?view=records&namespace=nested%2Ffixture&status=superseded`)
		).json();
		expect(superseded.total).toBe(1);
		expect(superseded.records[0].id).toBe("memory-0");
		const searched = await (
			await fetch(`${base}/memory/data?view=records&q=REPLACEMENT&kind=procedure&namespace=secondary`)
		).json();
		expect(searched.total).toBe(1);
		expect(searched.records[0].id).toBe("replacement");
		expect((await (await fetch(`${base}/memory/data?view=records&status=`)).json()).total).toBe(48);
		expect((await fetch(`${base}/memory/data?view=records&page=0`)).status).toBe(400);
		const rawMemory = await (await fetch(`${base}/memory/data`)).json();
		const rawNamespace = rawMemory.find((file: { namespace: string }) => file.namespace === "nested/fixture");
		expect(rawNamespace.records.length).toBeGreaterThan(50000);
		expect(rawNamespace.records).toContain("COMPLETE_RECORD_TAIL");
		expect(rawNamespace.records).not.toContain("[truncated]");
		const memoryHtml = await (await fetch(`${base}/memory`)).text();
		expect(memoryHtml).toContain("COMPLETE_RECORD_TAIL");
		expect(memoryHtml).not.toContain("Memory record 00");
		facts[1].text = "Memory record ZZ";
		await writeFile(join(memoryDirectory, "fixture.jsonl"), memoryContents());
		const changedMemory = await (
			await fetch(`${base}/memory/data?view=records&q=Memory%20record%20ZZ`)
		).json();
		expect(changedMemory.records).toHaveLength(1);
		expect(changedMemory.records[0].id).toBe("memory-1");
		await writeFile(join(directory, "service.log"), "old");
		expect((await (await fetch(`${base}/logs/data`)).json()).hostLog).toBe("old");
		await writeFile(join(directory, "service.log"), "new");
		expect((await (await fetch(`${base}/logs/data`)).json()).hostLog).toBe("new");
		const eventController = new AbortController();
		const eventResponse = await fetch(`${base}/events`, { signal: eventController.signal });
		expect(eventResponse.headers.get("content-encoding")).toBeNull();
		const eventReader = eventResponse.body?.getReader();
		try {
			const ready = new TextDecoder().decode((await eventReader?.read())?.value);
			expect(ready).toContain("event: ready");
			expect(ready).not.toContain('"updated":true');
			await other.submit(
				{
					type: "write",
					entry: {
						kind: "pi.user",
						model: [{ role: "user", content: "Newest committed message", timestamp: 456 }],
					},
				},
				BACKGROUND_CONTEXT,
			);
			expect(new TextDecoder().decode((await eventReader?.read())?.value)).toContain('"updated":true');
			const updated = await (await fetch(`${base}/chat/data?view=overview`)).json();
			expect(JSON.stringify(updated)).toContain("Newest committed message");
			expect(updated.revision).not.toBe(overview.revision);
		} finally {
			eventController.abort();
			await eventReader?.cancel().catch(() => {});
		}
		const history = await (await fetch(`${base}/?conversationId=${conversationId}`)).text();
		expect(history).toContain("&lt;script&gt;");
		expect(history).not.toContain("sk-fixturesecretkey");
		expect(history).toContain('href="/scheduled"');
		expect(history).not.toContain('href="/automation"');
		expect(history).toContain('class="app-nav"');
		expect(history).toContain("Recent Chats");
		expect(history).toContain('href="/assets/style.css"');
		expect(history).toContain('src="/assets/app.js"');
		expect(history).not.toContain('id="connection"');
		for (const [path, type] of [
			["/assets/style.css", "text/css"],
			["/assets/app.js", "text/javascript"],
		]) {
			const asset = await fetch(base + path);
			expect(asset.status).toBe(200);
			expect(asset.headers.get("content-type")).toContain(type);
			expect(asset.headers.get("content-encoding")).toBe("gzip");
			const assetText = await asset.text();
			expect(assetText.length).toBeGreaterThan(1024);
			if (path.endsWith("app.js")) {
				expect(assetText).not.toMatch(/EventSource|setInterval|visibilitychange|scheduleRefresh/);
				expect(assetText).toContain('addEventListener("click", refresh)');
				expect(assetText).not.toContain("Asia/Shanghai");
				expect(assetText).toContain("timeZone: timezone");
				expect(assetText).toContain("job.timezone");
			}
		}
		expect((await fetch(`${base}/assets/unknown.js`)).status).toBe(404);
		expect(faux.state.callCount).toBe(3);
		faux.setResponses([
			(context) => {
				const tools = context.messages
					.filter((message) => message.role === "system")
					.flatMap((message) => message.toolsAdded ?? []);
				expect(tools).toEqual([]);
				return fauxAssistantMessage("OK");
			},
		]);
		expect((await fetch(`${base}/health/model`)).status).toBe(200);
		expect(faux.state.callCount).toBe(4);
		const sessions = await agent.harness.snapshot(Sessions, BACKGROUND_CONTEXT);
		expect(sessions?.items).toHaveLength(1);
		expect(sessions?.items[0]).toMatchObject({ label: "model-health", deliver: false });

		// The Tasks tab follows subagent ownership and lazily reads the latest native payload.
		const childStarted = Promise.withResolvers<void>();
		const releaseChild = Promise.withResolvers<void>();
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", { task: "Tree probe <script> sk-fixturecheckpointkey" }),
				{ stopReason: "toolUse" },
			),
			async () => {
				childStarted.resolve();
				await releaseChild.promise;
				return fauxAssistantMessage("Child tree answer");
			},
			fauxAssistantMessage("Parent tree answer"),
		]);
		const treeRun = await agent.submit({ chatGuid: "chat", guid: "tree", text: "Delegate a tree probe" });
		try {
			await childStarted.promise;
			const callCount = faux.state.callCount;
			const tree = await (await fetch(`${base}/tasks/data`)).json();
			expect(tree.sessions.items).toContainEqual(
				expect.objectContaining({ label: "model-health", conversationId: sessions?.items[0].conversationId }),
			);
			const subagent = tree.tasks.find((task: { name?: string }) => task.name === "subagent");
			expect(subagent).toMatchObject({ conversationId, kind: "pi.tool", status: "running" });
			const child = tree.conversations.find(
				(conversation: { owner?: { taskId: number } }) => conversation.owner?.taskId === subagent.id,
			);
			expect(child.owner.conversationId).toBe(conversationId);
			expect(tree.tasks).toContainEqual(
				expect.objectContaining({ id: subagent.owner, kind: "pi.generation" }),
			);
			expect(tree.tasks).toContainEqual(
				expect.objectContaining({ conversationId: child.id, kind: "pi.generation" }),
			);
			expect(JSON.stringify(tree)).not.toContain("Tree probe");
			const taskResponse = await fetch(`${base}/tasks/task/data?taskId=${subagent.id}`);
			const taskText = await taskResponse.text();
			expect(JSON.parse(taskText).state.checkpoint).toMatchObject({ phase: "execute" });
			expect(taskText).toContain("[redacted]");
			expect(taskText).not.toContain("sk-fixturecheckpointkey");
			const treePage = await (await fetch(`${base}/tasks?conversationId=${conversationId}`)).text();
			expect(treePage).toContain('href="/tasks" class="active"');
			expect(treePage).not.toContain("Tree probe");
			expect((await fetch(`${base}/tasks/task/data?taskId=not-a-number`)).status).toBe(400);
			expect((await fetch(`${base}/tasks/task/data?taskId=999999999`)).status).toBe(404);
			expect((await fetch(`${base}/tasks`, { method: "POST" })).status).toBe(404);
			expect(faux.state.callCount).toBe(callCount);
			releaseChild.resolve();
			await treeRun.wait(BACKGROUND_CONTEXT);
			const completed = await (await fetch(`${base}/tasks/task/data?taskId=${subagent.id}`)).json();
			expect(completed.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
			expect(completed.state).not.toHaveProperty("checkpoint");
			const updatedTree = await (await fetch(`${base}/tasks/data`)).json();
			expect(updatedTree.revision).not.toBe(tree.revision);
			expect(updatedTree.tasks).toContainEqual(
				expect.objectContaining({ id: subagent.id, status: "terminal" }),
			);
		} finally {
			releaseChild.resolve();
		}
		// Native scans are paged; the tree must not silently stop at the first 100 records.
		const fixtureTask = defineTask<null, { phase: "idle" }, null>({
			name: "fixture.tree",
			version: 1,
			initial: () => ({ phase: "idle" }),
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
			phases: {
				idle: async (_task, runtime, context) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						context,
					);
				},
			},
		});
		const added = await agent.harness.commit(async (tx) => {
			const ids = [];
			for (let index = 0; index < 101; index++) {
				const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const taskId = await tx.createTask(fixtureTask, null, {
					conversationId: conversation.id,
					ownership: { kind: "conversation" },
				});
				ids.push({ conversationId: conversation.id, taskId });
			}
			return ids;
		}, BACKGROUND_CONTEXT);
		const fullTree = await (await fetch(`${base}/tasks/data`)).json();
		for (const { conversationId, taskId } of added) {
			expect(fullTree.conversations).toContainEqual(expect.objectContaining({ id: conversationId }));
			expect(fullTree.tasks).toContainEqual(expect.objectContaining({ id: taskId, conversationId }));
		}
	} finally {
		await web?.close();
		await agent?.close();
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	}
});
