import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
	MEMORY_KINDS,
	type MemoryKind,
	type MemorySource,
	type StructuredMemoryItem,
	activeMemoryItems,
} from "./memory.js";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 20_000;
const MAX_HISTORY = 200;
const NAMESPACE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/;
const CHAT_DIRECTORY = /^(?:iMessage|SMS|RCS);[+-];[a-zA-Z0-9_\-+.@]+$/;
export const MEMORY_VIEWS = [
	{ id: "structured", label: "结构化记忆" },
	{ id: "core", label: "Core" },
	{ id: "agents", label: "Agent 规则" },
	{ id: "system", label: "系统变更日志" },
	{ id: "archives", label: "历史归档" },
] as const;
export const MEMORY_STATUSES = [
	{ id: "effective", label: "当前有效" },
	{ id: "historical", label: "历史 / 已替代" },
	{ id: "uncertain", label: "无法确认" },
	{ id: "all", label: "全部记录" },
] as const;
type EffectiveStatus = "effective" | "historical" | "uncertain";
export interface MemoryQuery {
	view: string;
	q: string;
	namespace: string;
	kind: string;
	status: string;
	page: number;
	size: number;
	record: string;
	doc: string;
}
export class MemoryQueryError extends Error {}
export function parseMemoryQuery(params: URLSearchParams): MemoryQuery {
	const allowed = new Set(["view", "q", "namespace", "kind", "status", "page", "size", "record", "doc"]);
	const seen = new Set<string>();
	for (const [key, value] of params) {
		if (!allowed.has(key) || seen.has(key) || value.length > (key === "q" ? 300 : 200)) {
			throw new MemoryQueryError("参数未知、重复或过长");
		}
		seen.add(key);
	}
	const query: MemoryQuery = {
		view: params.get("view") || "structured",
		q: (params.get("q") || "").trim(),
		namespace: params.get("namespace") || "",
		kind: params.get("kind") || "",
		status: params.get("status") || "effective",
		page: Number(params.get("page") || 1),
		size: Number(params.get("size") || 20),
		record: params.get("record") || "",
		doc: params.get("doc") || "",
	};
	if (
		!MEMORY_VIEWS.some(({ id }) => id === query.view) ||
		!MEMORY_STATUSES.some(({ id }) => id === query.status) ||
		(query.kind && !MEMORY_KINDS.includes(query.kind as MemoryKind)) ||
		!Number.isInteger(query.page) ||
		query.page < 1 ||
		query.page > 100_000 ||
		![10, 20, 50].includes(query.size) ||
		(query.record && !/^[a-f0-9]{24}$/.test(query.record)) ||
		(query.doc && !/^[a-f0-9]{24}$/.test(query.doc))
	)
		throw new MemoryQueryError("筛选参数无效");
	return query;
}
export function memoryLink(query: MemoryQuery, changes: Partial<MemoryQuery> = {}): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries({ ...query, ...changes })) {
		if (value !== "") params.set(key, String(value));
	}
	return `/memory?${params}`;
}
function opaque(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 16_384;
}
function validDate(value: unknown, factual: boolean): value is string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
	return factual
		? /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value
		: /^\d{4}-\d{2}-\d{2}T/.test(value);
}

// Roots are server-owned. The stable file-memory root may intentionally be a symlink.
// Below a root, reject every symlink and non-regular file; never follow source paths.
function safePath(root: string, name: string): string {
	const parts = name.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
		throw new Error("unsafe path");
	let path = root;
	for (const part of parts) {
		path = join(path, part);
		if (lstatSync(path).isSymbolicLink()) throw new Error("symlink");
	}
	if (!realpathSync(path).startsWith(`${root}${sep}`)) throw new Error("outside root");
	return path;
}
function readBounded(root: string, name: string, limit: number): string {
	const descriptor = openSync(safePath(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size > limit) throw new Error("not a bounded regular file");
		// Read only the validated size: concurrent appends cannot make this read unbounded.
		const buffer = Buffer.alloc(stat.size);
		// readFileSync on a descriptor can grow without bounds, so use a fixed-size read below.
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
			if (!count) break;
			offset += count;
		}
		if (offset !== stat.size || fstatSync(descriptor).size !== stat.size) throw new Error("changed while reading");
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} finally {
		closeSync(descriptor);
	}
}

export interface MemoryRow {
	key: string;
	item: Omit<StructuredMemoryItem, "importance" | "confidence" | "kind"> & {
		kind: MemoryKind | null;
		importance: number | null;
		confidence: number | null;
	};
	file: string;
	line: number;
	effective: EffectiveStatus;
	diagnostics: string[];
}
interface Snapshot {
	rows: MemoryRow[];
	diagnostics: string[];
	complete: boolean;
}
function readSnapshot(workingDir: string): Snapshot {
	const snapshot: Snapshot = { rows: [], diagnostics: [], complete: true };
	let issueCount = 0;
	const issue = (message: string) => {
		snapshot.complete = false;
		if (issueCount++ < 100) snapshot.diagnostics.push(message);
	};
	let root: string;
	try {
		root = realpathSync(join(workingDir, "skills/file-memory"));
		safePath(root, "namespaces");
	} catch {
		issue("namespaces：目录缺失、不可读或不安全，不能确认有效记忆");
		return snapshot;
	}
	let bytes = 0;
	let entries = 0;
	let files = 0;
	function walk(directory: string, depth: number): void {
		if (depth > 8 || entries >= 4096 || files >= 1024 || bytes >= MAX_BYTES || snapshot.rows.length >= MAX_RECORDS) {
			issue("扫描达到安全上限，结果不完整");
			return;
		}
		try {
			const children = readdirSync(safePath(root, directory), { withFileTypes: true }).sort((a, b) =>
				compare(a.name, b.name)
			);
			for (const entry of children) {
				if (++entries > 4096 || files >= 1024 || bytes >= MAX_BYTES || snapshot.rows.length >= MAX_RECORDS) {
					issue("扫描达到安全上限，结果不完整");
					break;
				}
				const name = `${directory}/${entry.name}`;
				if (entry.isSymbolicLink()) {
					issue(`${name}：已拒绝符号链接`);
					continue;
				}
				if (entry.isDirectory()) {
					walk(name, depth + 1);
					continue;
				}
				if (!entry.name.endsWith(".jsonl")) continue;
				files++;
				try {
					const content = readBounded(root, name, Math.min(4 * 1024 * 1024, MAX_BYTES - bytes));
					bytes += Buffer.byteLength(content);
					for (const [index, line] of content.split("\n").entries()) {
						if (!line.trim()) continue;
						if (snapshot.rows.length >= MAX_RECORDS) {
							issue("记录达到安全上限，结果不完整");
							break;
						}
						const location = `${name}:${index + 1}`;
						try {
							if (line.length > 65_536) throw new Error("long line");
							const value: unknown = JSON.parse(line);
							if (
								!object(value) ||
								!text(value.id) ||
								value.id.length > 200 ||
								!text(value.text) ||
								!text(value.namespace) ||
								value.namespace.length > 200 ||
								!["active", "superseded"].includes(String(value.status)) ||
								(value.supersedes_id !== undefined && (!text(value.supersedes_id) || value.supersedes_id.length > 200))
							) {
								throw new Error("invalid topology");
							}
							const diagnostics: string[] = [];
							const expected = name.slice("namespaces/".length, -6);
							if (!NAMESPACE.test(value.namespace) || value.namespace !== expected)
								diagnostics.push("namespace 与文件路径不符或格式无效");
							const subjects = Array.isArray(value.subjects) ? value.subjects.filter(text).slice(0, 100) : [];
							if (!Array.isArray(value.subjects) || subjects.length !== value.subjects.length)
								diagnostics.push("subjects 缺失或无效");
							const sources: MemorySource[] = [];
							if (Array.isArray(value.sources)) {
								for (const source of value.sources.slice(0, 100)) {
									if (!object(source) || !text(source.type) || !text(source.label)) {
										diagnostics.push("source 无效，已忽略该来源");
										continue;
									}
									const cleaned: MemorySource = { type: source.type, label: source.label };
									for (const field of ["path", "block_hash"] as const) {
										if (source[field] !== undefined) {
											if (text(source[field])) cleaned[field] = source[field];
											else diagnostics.push(`source.${field} 无效`);
										}
									}
									for (const field of ["line_start", "line_end"] as const) {
										const number = source[field];
										if (number !== undefined) {
											if (typeof number === "number" && Number.isSafeInteger(number) && number > 0)
												cleaned[field] = number;
											else diagnostics.push(`source.${field} 无效`);
										}
									}
									if (cleaned.line_start && cleaned.line_end && cleaned.line_start > cleaned.line_end)
										diagnostics.push("source 行号顺序无效");
									sources.push(cleaned);
								}
								if (value.sources.length > 100) diagnostics.push("sources 超过 100，已截断");
							}
							if (!sources.length) diagnostics.push("来源未知 / 缺失");
							const score = (field: "importance" | "confidence") => {
								const number = value[field];
								if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1) return number;
								diagnostics.push(`${field} 未知 / 无效`);
								return null;
							};
							if (!MEMORY_KINDS.includes(value.kind as MemoryKind)) diagnostics.push("kind 未知 / 无效");
							if (value.event_time !== null && !validDate(value.event_time, true))
								diagnostics.push("事实日期缺失或无效");
							if (!validDate(value.created_at, false)) diagnostics.push("创建日期缺失或无效");
							snapshot.rows.push({
								key: opaque(location),
								file: name,
								line: index + 1,
								effective: "uncertain",
								diagnostics,
								item: {
									id: value.id,
									text: value.text,
									namespace: value.namespace,
									kind: MEMORY_KINDS.includes(value.kind as MemoryKind) ? (value.kind as MemoryKind) : null,
									subjects,
									sources,
									status: value.status as "active" | "superseded",
									event_time: validDate(value.event_time, true) ? value.event_time : null,
									created_at: validDate(value.created_at, false) ? value.created_at : "",
									importance: score("importance"),
									confidence: score("confidence"),
									...(typeof value.supersedes_id === "string" ? { supersedes_id: value.supersedes_id } : {}),
								},
							});
						} catch {
							issue(`${location}：JSON 或必需字段无效，已跳过；有效性无法完整计算`);
						}
					}
				} catch {
					issue(`${name}：文件不可读、无效 UTF-8、过大或不安全`);
				}
			}
		} catch {
			issue(`${directory}：目录不可读或不安全`);
		}
	}
	walk("namespaces", 0);
	if (!files) issue("namespaces：未找到 JSONL 文件");
	if (issueCount > 100) snapshot.diagnostics.push(`另有 ${issueCount - 100} 条诊断未展开`);
	const byId = new Map<string, MemoryRow[]>();
	for (const row of snapshot.rows) {
		const group = byId.get(row.item.id) || [];
		group.push(row);
		byId.set(row.item.id, group);
	}
	if ([...byId.values()].some((group) => group.length > 1)) issue("重复 ID：整个快照的有效性无法完整确认");
	for (const row of snapshot.rows) {
		if ((byId.get(row.item.id)?.length || 0) > 1) row.diagnostics.push("重复 ID：所有版本均保留，有效性无法确认");
		if (row.item.supersedes_id && !byId.has(row.item.supersedes_id))
			row.diagnostics.push(`缺失前驱：${row.item.supersedes_id}`);
	}
	// Functional graph walk, not recursion. Duplicates remain separate rows in history.
	const visited = new Set<string>();
	for (const id of byId.keys()) {
		const path = new Set<string>();
		let current: string | undefined = id;
		while (current && byId.has(current) && !visited.has(current)) {
			if (path.has(current)) {
				for (const member of path) for (const row of byId.get(member) || []) row.diagnostics.push("更正链包含循环");
				break;
			}
			path.add(current);
			current = byId.get(current)?.[0].item.supersedes_id;
		}
		for (const member of path) visited.add(member);
	}
	const effective = activeMemoryItems(
		snapshot.rows.map(({ item }) => ({
			...item,
			kind: item.kind ?? "fact",
			importance: item.importance ?? 0,
			confidence: item.confidence ?? 0,
		}))
	);
	const effectiveIds = new Set(effective.map((item) => item.id));
	for (const row of snapshot.rows) {
		row.effective =
			!snapshot.complete || row.diagnostics.length
				? "uncertain"
				: effectiveIds.has(row.item.id)
					? "effective"
					: "historical";
	}
	const malformed = snapshot.rows.filter((row) => row.diagnostics.length).length;
	if (malformed) snapshot.diagnostics.push(`${malformed} 条记录有字段 / 更正链诊断；这些记录不标为当前有效`);
	return snapshot;
}
function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
function rowOrder(left: MemoryRow, right: MemoryRow): number {
	return (
		(right.item.created_at ? Date.parse(right.item.created_at) : Number.NEGATIVE_INFINITY) -
			(left.item.created_at ? Date.parse(left.item.created_at) : Number.NEGATIVE_INFINITY) ||
		compare(left.item.id, right.item.id) ||
		compare(left.file, right.file) ||
		left.line - right.line
	);
}

export interface MemoryDocument {
	id: string;
	label: string;
	scope: string;
	content?: string;
	diagnostic?: string;
}
// This is an explicit source allowlist, not the SDK's recursive context discovery.
function documents(
	workingDir: string,
	agentRoot: string,
	query: MemoryQuery
): { documents: MemoryDocument[]; diagnostics: string[] } {
	const catalog: Array<MemoryDocument & { root: string; name: string }> = [];
	const diagnostics: string[] = [];
	const add = (root: string, name: string, label: string, scope: string) =>
		catalog.push({ id: opaque(`${query.view}:${label}`), root, name, label, scope });
	if (query.view === "core")
		add(
			join(workingDir, "skills/file-memory"),
			"core.md",
			"skills/file-memory/core.md",
			"精简常驻上下文；普通会话 system prompt 使用，不是完整记忆库"
		);
	if (query.view === "agents") {
		add(
			agentRoot,
			"AGENTS.md",
			"agentDir / AGENTS.md",
			"全局规则：当前 SDK agentDir（默认 ~/.pi/agent）；同目录 override 文件可能覆盖它，不代表已有会话已重载"
		);
		add(
			workingDir,
			"AGENTS.md",
			"workingDir/AGENTS.md",
			"工作区规则固定展示源；仅适用于以此 workingDir 为 cwd 的运行时，不代表任意 chat/scratch 文件适用"
		);
	}
	if (query.view === "system" || query.view === "archives") {
		const filename = query.view === "system" ? "SYSTEM.md" : "MEMORY.md";
		add(
			workingDir,
			filename,
			`global / ${filename}`,
			query.view === "system"
				? "全局系统操作日志；普通会话 prompt 会附加，不是记忆"
				: "全局旧档案；停用，不参与结构化检索"
		);
		try {
			const root = realpathSync(workingDir);
			const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name));
			if (entries.length > 4096) diagnostics.push("目录条目超过 4096，仅展示有界目录清单");
			for (const entry of entries.slice(0, 4096)) {
				if (!CHAT_DIRECTORY.test(entry.name)) continue;
				if (entry.isSymbolicLink()) {
					diagnostics.push(`${entry.name}：已拒绝链接目录`);
					continue;
				}
				if (!entry.isDirectory()) continue;
				try {
					const path = safePath(root, `${entry.name}/${filename}`);
					if (!lstatSync(path).isFile()) throw new Error("not file");
					add(
						root,
						`${entry.name}/${filename}`,
						`${entry.name} / ${filename}`,
						query.view === "system"
							? "仅该普通聊天会话的操作日志；不代表其他聊天或隔离任务"
							: "聊天旧档案；停用，不参与结构化检索"
					);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT")
						diagnostics.push(`${entry.name}/${filename}：不可读或不安全`);
				}
			}
		} catch {
			diagnostics.push("工作区目录不可读；文档清单不完整");
		}
	}
	const selected = query.doc || catalog[0]?.id;
	if (query.doc && !catalog.some(({ id }) => id === selected)) throw new MemoryQueryError("文档 ID 不在允许清单内");
	return {
		documents: catalog.map(({ root, name, ...document }) => {
			if (document.id !== selected) return document;
			try {
				const content = readBounded(realpathSync(root), name, 256 * 1024);
				return { ...document, content, ...(!content.trim() ? { diagnostic: "文件为空" } : {}) };
			} catch {
				return { ...document, diagnostic: "文件缺失、不可读、过大或不安全（不跟随文档符号链接）" };
			}
		}),
		diagnostics,
	};
}
export function readMemoryView(workingDir: string, query: MemoryQuery, agentRoot = join(homedir(), ".pi/agent")) {
	const snapshot =
		query.view === "structured" ? readSnapshot(workingDir) : { rows: [], diagnostics: [], complete: true };
	const rows = snapshot.rows.sort(rowOrder);
	const namespaces = [...new Set(rows.map(({ item }) => item.namespace))].sort(compare);
	const terms = query.q
		.toLowerCase()
		.split(/[\s,，、]+/)
		.filter(Boolean);
	const filtered = rows.filter(
		({ item, file }) =>
			(!query.namespace || item.namespace === query.namespace) &&
			(!query.kind || item.kind === query.kind) &&
			terms.every((term) =>
				[
					item.id,
					item.text,
					item.namespace,
					item.kind,
					...item.subjects,
					item.event_time || "",
					item.created_at,
					item.supersedes_id || "",
					file,
					...item.sources.flatMap((source) => Object.values(source).map(String)),
				]
					.join(" ")
					.toLowerCase()
					.includes(term)
			)
	);
	const counts = { all: filtered.length, effective: 0, historical: 0, uncertain: 0 };
	for (const row of filtered) counts[row.effective]++;
	const matches = filtered.filter((row) => query.status === "all" || row.effective === query.status);
	const pages = Math.max(1, Math.ceil(matches.length / query.size));
	const page = Math.min(query.page, pages);
	const history: MemoryRow[] = [];
	const historyDiagnostics: string[] = [];
	if (query.record) {
		const selected = rows.find((row) => row.key === query.record);
		if (!selected) historyDiagnostics.push("记录不存在或文件位置已变化；请刷新列表");
		else {
			const byId = new Map<string, MemoryRow[]>();
			const successors = new Map<string, MemoryRow[]>();
			for (const row of rows) {
				const group = byId.get(row.item.id) || [];
				group.push(row);
				byId.set(row.item.id, group);
				if (row.item.supersedes_id) {
					const children = successors.get(row.item.supersedes_id) || [];
					children.push(row);
					successors.set(row.item.supersedes_id, children);
				}
			}
			const pending = [selected];
			const seen = new Set([selected.key]);
			for (let index = 0; index < pending.length && history.length < MAX_HISTORY; index++) {
				const row = pending[index];
				history.push(row);
				const related = [
					...(byId.get(row.item.id) || []),
					...(byId.get(row.item.supersedes_id || "") || []),
					...(successors.get(row.item.id) || []),
				];
				for (const next of related) {
					if (seen.has(next.key)) continue;
					seen.add(next.key);
					if (pending.length < MAX_HISTORY) pending.push(next);
					else if (!historyDiagnostics.length)
						historyDiagnostics.push(`更正历史超过 ${MAX_HISTORY} 条，已截断；请从相关记录继续查看`);
				}
			}
			history.sort(rowOrder);
		}
	}
	const docs = documents(workingDir, agentRoot, query);
	return {
		query: { ...query, page },
		namespaces,
		counts,
		total: rows.length,
		complete: snapshot.complete,
		matches: matches.length,
		page,
		pages,
		rows: matches.slice((page - 1) * query.size, page * query.size),
		history,
		historyDiagnostics,
		documents: docs.documents,
		diagnostics: [...snapshot.diagnostics, ...docs.diagnostics],
	};
}
export type MemoryViewData = ReturnType<typeof readMemoryView>;
