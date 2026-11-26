import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentContent, StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * Replay `durable/main.jsonl` plus its sidecars into a SQLite file.
 *
 * JSONL recovery rebuilds every record in the heap. SQLite stores the current
 * row and document revisions on disk, so startup no longer depends on journal size.
 * Live task sidecars collapse to the latest snapshot. Reclaimed document history
 * is skipped the same way JSONL recovery skips it. Commit sequence numbers are
 * reassigned in journal order.
 */

type Location = {
	path: string;
	offset: number;
	length: number;
};

type Point = {
	seq: number;
	ordinal: number;
};

type JournalDocument = {
	id: number;
	kind: string;
	scope: { kind: string };
	history?: string;
};

type JournalWrite = {
	type: string;
	id?: number;
	ordinal?: number;
	value?: { id: number };
	record?: JournalDocument;
};

type Marker = {
	seq: number;
	writes: JournalWrite[];
};

type ReplayState = {
	currentOnly: Set<number>;
	retired: Set<number>;
	taskLive: Map<number, boolean>;
	lastLive: Map<number, Point>;
	latestBase: Map<number, Point>;
};

const BATCH_WRITES = 200;
const BATCH_BYTES = 4_000_000;

function isCurrentOnly(record: JournalDocument): boolean {
	return record.scope.kind !== "conversation" || record.history === "latest";
}

function keyOf(file: string, seq: number, ordinal: number): string {
	return `${file}\t${seq}\t${ordinal}`;
}

async function indexSidecars(directory: string): Promise<Map<string, Location>> {
	const index = new Map<string, Location>();
	const names = (await readdir(directory)).filter(
		(name) => (name.startsWith("doc-") || name.startsWith("task-")) && name.endsWith(".jsonl"),
	);
	for (const name of names) {
		const path = join(directory, name);
		let offset = 0;
		const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
		for await (const line of lines) {
			const bytes = Buffer.byteLength(line);
			if (line.length > 0) {
				const header = /^\{"format":1,"type":"record","seq":(\d+),"ordinal":(\d+),/.exec(line.slice(0, 96));
				if (!header) throw new Error(`Unreadable sidecar record in ${name}`);
				index.set(keyOf(name, Number(header[1]), Number(header[2])), { path, offset, length: bytes });
			}
			offset += bytes + 1;
		}
	}
	return index;
}

async function payload(
	index: Map<string, Location>,
	handles: Map<string, FileHandle>,
	file: string,
	seq: number,
	ordinal: number,
): Promise<unknown> {
	const location = index.get(keyOf(file, seq, ordinal));
	if (!location) return undefined;
	let handle = handles.get(location.path);
	if (!handle) {
		handle = await open(location.path, "r");
		handles.set(location.path, handle);
	}
	const buffer = Buffer.alloc(location.length);
	const read = await handle.read(buffer, 0, location.length, location.offset);
	if (read.bytesRead !== location.length) throw new Error(`Short sidecar read of ${file} at sequence ${seq}`);
	const record = JSON.parse(buffer.toString("utf8")) as { payload?: unknown };
	return record.payload;
}

async function contentKind(
	index: Map<string, Location>,
	handles: Map<string, FileHandle>,
	file: string,
	seq: number,
	ordinal: number,
): Promise<string | undefined> {
	const body = (await payload(index, handles, file, seq, ordinal)) as
		| { content?: { kind?: string } }
		| undefined;
	return body?.content?.kind;
}

async function scanMarkers(
	mainPath: string,
	index: Map<string, Location>,
	handles: Map<string, FileHandle>,
	state: ReplayState,
): Promise<void> {
	const lines = createInterface({ input: createReadStream(mainPath), crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.length === 0) continue;
		const marker = JSON.parse(line) as Marker;
		for (const write of marker.writes) {
			if (write.type === "document.create" && write.record && isCurrentOnly(write.record)) {
				state.currentOnly.add(write.record.id);
			} else if (write.type === "document.retire" && write.id !== undefined) {
				state.retired.add(write.id);
			} else if (write.type === "task" && write.value && "id" in write.value) {
				state.taskLive.set(Number(write.value.id), false);
			} else if (write.type === "task.sidecar" && write.id !== undefined && write.ordinal !== undefined) {
				state.taskLive.set(write.id, true);
				state.lastLive.set(write.id, { seq: marker.seq, ordinal: write.ordinal });
			}
			if (
				(write.type === "document.create" || write.type === "document.change") &&
				write.ordinal !== undefined
			) {
				const id = write.type === "document.create" ? write.record?.id : write.id;
				if (id === undefined || !state.currentOnly.has(id)) continue;
				const kind = await contentKind(index, handles, `doc-${id}.jsonl`, marker.seq, write.ordinal);
				if (kind !== "base") continue;
				const previous = state.latestBase.get(id);
				const point = { seq: marker.seq, ordinal: write.ordinal };
				if (
					previous === undefined ||
					point.seq > previous.seq ||
					(point.seq === previous.seq && point.ordinal > previous.ordinal)
				) {
					state.latestBase.set(id, point);
				}
			}
		}
	}
}

function beforeLatestBase(state: ReplayState, id: number, seq: number, ordinal: number): boolean {
	const base = state.latestBase.get(id);
	return base !== undefined && (seq < base.seq || (seq === base.seq && ordinal < base.ordinal));
}

async function writesFor(
	marker: Marker,
	state: ReplayState,
	index: Map<string, Location>,
	handles: Map<string, FileHandle>,
): Promise<StorageWrite[]> {
	const writes: StorageWrite[] = [];
	for (const write of marker.writes) {
		switch (write.type) {
			case "conversation":
			case "entry":
			case "submission":
			case "document.retire":
				writes.push(write as StorageWrite);
				break;
			case "task":
				writes.push(write as StorageWrite);
				break;
			case "task.sidecar": {
				if (write.id === undefined || write.ordinal === undefined) {
					throw new Error(`Task sidecar marker at sequence ${marker.seq} has no id`);
				}
				const live = state.taskLive.get(write.id) === true;
				const last = state.lastLive.get(write.id);
				if (!live || last?.seq !== marker.seq || last.ordinal !== write.ordinal) break;
				const body = (await payload(index, handles, `task-${write.id}.jsonl`, marker.seq, write.ordinal)) as
					| { type?: string; value?: { id: number } }
					| undefined;
				if (body?.type !== "task" || body?.value === undefined) {
					throw new Error(`Missing live task sidecar ${write.id} at sequence ${marker.seq}`);
				}
				writes.push({ type: "task", value: body.value } as StorageWrite);
				break;
			}
			case "document.create":
			case "document.change": {
				if (write.ordinal === undefined)
					throw new Error(`Document marker at sequence ${marker.seq} has no ordinal`);
				const id = write.type === "document.create" ? write.record?.id : write.id;
				if (id === undefined) throw new Error(`Document marker at sequence ${marker.seq} has no id`);
				const reclaimed =
					(state.retired.has(id) && state.currentOnly.has(id)) ||
					beforeLatestBase(state, id, marker.seq, write.ordinal);
				const body = (await payload(index, handles, `doc-${id}.jsonl`, marker.seq, write.ordinal)) as
					| { type?: string; id?: number; content?: DocumentContent }
					| undefined;
				if (body === undefined && !reclaimed) {
					throw new Error(`Missing document sidecar ${id} at sequence ${marker.seq}`);
				}
				if (
					body !== undefined &&
					(body.type !== "document" || body.id !== id || body.content === undefined)
				) {
					throw new Error(`Document sidecar ${id} does not match commit ${marker.seq}`);
				}
				if (write.type === "document.create") {
					if (body?.content !== undefined && body.content.kind !== "base") {
						throw new Error(`Document creation lacks a base in commit ${marker.seq}`);
					}
					if (!write.record) throw new Error(`Document creation at sequence ${marker.seq} has no record`);
					const content =
						reclaimed || body?.content === undefined
							? { kind: "base" as const, version: 1, value: {} }
							: body.content;
					writes.push({ type: "document.create", record: write.record, content } as StorageWrite);
				} else if (!reclaimed && body?.content !== undefined) {
					writes.push({ type: "document.change", id, content: body.content } as StorageWrite);
				}
				break;
			}
			default:
				throw new Error(`Unsupported journal write ${write.type} at sequence ${marker.seq}`);
		}
	}
	return writes;
}

/** Copy one JSONL durable directory into `sqlitePath`. Leaves the JSONL files in place. */
export async function migrateJsonlToSqlite(directory: string, sqlitePath: string): Promise<void> {
	const mainPath = join(directory, "main.jsonl");
	await stat(mainPath);
	const partial = `${sqlitePath}.migrating`;
	await rm(partial, { force: true });
	await rm(`${partial}-wal`, { force: true });
	await rm(`${partial}-shm`, { force: true });
	const started = Date.now();
	console.error(new Date().toISOString(), "Migrating JSONL durable storage to SQLite");
	const index = await indexSidecars(directory);
	const handles = new Map<string, FileHandle>();
	const state: ReplayState = {
		currentOnly: new Set(),
		retired: new Set(),
		taskLive: new Map(),
		lastLive: new Map(),
		latestBase: new Map(),
	};
	try {
		await scanMarkers(mainPath, index, handles, state);
		const storage = await openNodeSqliteStorage(partial);
		const pending: StorageWrite[][] = [];
		let pendingBytes = 0;
		let stored = 0;
		let seen = 0;
		const flush = async () => {
			if (pending.length === 0) return;
			const batch = pending.splice(0, pending.length);
			pendingBytes = 0;
			const result = await storage.commit(batch, () => {}, BACKGROUND_CONTEXT);
			if (result.refused !== undefined || result.stored !== batch.length) {
				throw new Error(`SQLite refused a migrated commit after ${stored} stored`, {
					cause: result.refused,
				});
			}
			stored += result.stored;
		};
		const lines = createInterface({ input: createReadStream(mainPath), crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				if (line.length === 0) continue;
				seen += 1;
				const writes = await writesFor(JSON.parse(line) as Marker, state, index, handles);
				if (writes.length === 0) continue;
				const bytes = Buffer.byteLength(line);
				if (pending.length > 0 && (pending.length >= BATCH_WRITES || pendingBytes + bytes > BATCH_BYTES)) {
					await flush();
				}
				pending.push(writes);
				pendingBytes += bytes;
				if (bytes > BATCH_BYTES) await flush();
				if (seen % 50000 === 0) {
					console.error(
						new Date().toISOString(),
						`Migration progress ${seen} journal commits, ${stored} stored`,
					);
				}
			}
			await flush();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
		await rename(partial, sqlitePath);
		console.error(
			new Date().toISOString(),
			`Migrated ${seen} journal commits into ${stored} SQLite commits in ${Math.round((Date.now() - started) / 1000)}s`,
		);
	} finally {
		await Promise.all([...handles.values()].map((handle) => handle.close()));
		await rm(partial, { force: true });
		await rm(`${partial}-wal`, { force: true });
		await rm(`${partial}-shm`, { force: true });
	}
}
