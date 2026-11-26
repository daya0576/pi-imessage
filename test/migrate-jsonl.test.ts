import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { migrateJsonlToSqlite } from "../src/agent/migrate-jsonl.ts";

it("replays JSONL durable storage into SQLite and keeps current records", async () => {
	const directory = await mkdtemp(join(tmpdir(), "imessage-migrate-"));
	const durable = join(directory, "durable");
	try {
		const jsonl = await openNodeJsonlStorage(durable, BACKGROUND_CONTEXT, { fsync: false });
		const conversationId = await jsonl.mintId();
		const entryId = await jsonl.mintId();
		const latestId = await jsonl.mintId();
		const rewindId = await jsonl.mintId();
		const liveId = await jsonl.mintId();
		const doneId = await jsonl.mintId();
		const commit = async (writes: readonly object[]) => {
			const result = await jsonl.commit([writes as readonly StorageWrite[]], () => {}, BACKGROUND_CONTEXT);
			expect(result.refused).toBeUndefined();
		};
		await commit([{ type: "conversation", value: { id: conversationId } }]);
		await commit([
			{ type: "entry", value: { id: entryId, conversationId, kind: "pi.user", data: { text: "kept" } } },
		]);
		await commit([
			{
				type: "document.create",
				record: {
					id: latestId,
					kind: "test.latest",
					scope: { kind: "conversation", conversationId },
					history: "latest",
					fork: "initial",
				},
				content: { kind: "base", version: 1, value: { n: 1 } },
			},
		]);
		await commit([
			{
				type: "document.change",
				id: latestId,
				content: { kind: "delta", version: 1, ops: [["s", ["n"], 2]] },
			},
		]);
		await commit([
			{ type: "document.change", id: latestId, content: { kind: "base", version: 1, value: { n: 3 } } },
		]);
		await commit([
			{
				type: "document.create",
				record: {
					id: rewindId,
					kind: "test.rewind",
					scope: { kind: "conversation", conversationId },
					history: "rewindable",
					fork: "asOf",
				},
				content: { kind: "base", version: 1, value: { n: 1 } },
			},
		]);
		await commit([
			{
				type: "document.change",
				id: rewindId,
				content: { kind: "delta", version: 1, ops: [["s", ["n"], 4]] },
			},
		]);
		const task = (id: typeof liveId, phase: string, terminal: boolean) => ({
			id,
			conversationId,
			kind: "test.task",
			version: 1,
			input: {},
			background: true,
			abortRequested: false,
			state: terminal
				? { status: "terminal" as const, outcome: { status: "completed" as const, result: null } }
				: { status: "pending" as const, checkpoint: { phase } },
		});
		await commit([{ type: "task", value: task(liveId, "one", false) }]);
		await commit([{ type: "task", value: task(liveId, "two", false) }]);
		await commit([{ type: "task", value: task(doneId, "run", false) }]);
		await commit([{ type: "task", value: task(doneId, "run", true) }]);
		await jsonl.close(BACKGROUND_CONTEXT);

		const sqlitePath = join(durable, "pi.sqlite");
		await migrateJsonlToSqlite(durable, sqlitePath);
		const sqlite = await openNodeSqliteStorage(sqlitePath);
		try {
			expect((await sqlite.entry(entryId as never, BACKGROUND_CONTEXT))?.entry.data).toEqual({
				text: "kept",
			});
			expect((await sqlite.document(latestId as never, "current", BACKGROUND_CONTEXT))?.value).toEqual({
				n: 3,
			});
			expect((await sqlite.document(rewindId as never, "current", BACKGROUND_CONTEXT))?.value).toEqual({
				n: 4,
			});
			expect((await sqlite.task(liveId as never, BACKGROUND_CONTEXT))?.state).toMatchObject({
				status: "pending",
				checkpoint: { phase: "two" },
			});
			expect((await sqlite.task(doneId as never, BACKGROUND_CONTEXT))?.state.status).toBe("terminal");
			expect((await sqlite.conversation(conversationId as never, BACKGROUND_CONTEXT))?.id).toBe(
				conversationId,
			);
		} finally {
			await sqlite.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
