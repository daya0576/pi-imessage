/**
 * Incremental collectors for nightly reflection inputs:
 * chat logs, blog Atom/RSS, GitHub public events.
 */

import { type Message, listChatGuids, readChatLog } from "./store.js";

export const BOOTSTRAP_MS = 48 * 60 * 60 * 1000;
export const MAX_CHAT_MESSAGES = 40;
export const MAX_BLOG_ITEMS = 20;
export const MAX_GITHUB_EVENTS = 30;
export const MAX_MESSAGE_CHARS = 500;
export const MAX_BLOG_CHARS = 1200;

export type ReflectionSourceKind = "chat" | "blog" | "github";

export interface ReflectionSourceItem {
	source: ReflectionSourceKind;
	id: string;
	at: string;
	text: string;
	label: string;
}

export interface SourceCheckpoints {
	chats: Record<string, { processedLines: number }>;
	blog: { seenGuids: string[] };
	github: { seenIds: string[] };
}

export interface CollectedSources {
	items: ReflectionSourceItem[];
	next: SourceCheckpoints;
	stats: { chats: number; chatMessages: number; blog: number; github: number };
	bootstrapped: { chats: boolean; blog: boolean; github: boolean };
}

export interface SourceFetchers {
	fetchBlogFeed?: (url: string) => Promise<string>;
	fetchGithubEvents?: (user: string) => Promise<unknown>;
}

export interface CollectSourcesInput {
	workingDir: string;
	checkpoint: SourceCheckpoints;
	blogUrl: string;
	githubUser: string;
	now?: Date;
	fetchers?: SourceFetchers;
}

export function emptySourceCheckpoints(): SourceCheckpoints {
	return { chats: {}, blog: { seenGuids: [] }, github: { seenIds: [] } };
}

export async function collectReflectionSources(input: CollectSourcesInput): Promise<CollectedSources> {
	const now = input.now ?? new Date();
	const next: SourceCheckpoints = {
		chats: { ...input.checkpoint.chats },
		blog: { seenGuids: [...input.checkpoint.blog.seenGuids] },
		github: { seenIds: [...input.checkpoint.github.seenIds] },
	};
	const items: ReflectionSourceItem[] = [];
	const bootstrapped = { chats: false, blog: false, github: false };

	const chat = collectChatSources(input.workingDir, next, now);
	items.push(...chat.items);
	bootstrapped.chats = chat.bootstrapped;

	const blog = await collectBlogSources(input.blogUrl, next, now, input.fetchers?.fetchBlogFeed);
	items.push(...blog.items);
	bootstrapped.blog = blog.bootstrapped;

	const github = await collectGithubSources(input.githubUser, next, now, input.fetchers?.fetchGithubEvents);
	items.push(...github.items);
	bootstrapped.github = github.bootstrapped;

	items.sort((a, b) => a.at.localeCompare(b.at));
	return {
		items,
		next,
		stats: {
			chats: chat.chatCount,
			chatMessages: chat.items.length,
			blog: blog.items.length,
			github: github.items.length,
		},
		bootstrapped,
	};
}

export function formatSourceItemsForPrompt(items: ReflectionSourceItem[]): string {
	if (items.length === 0) return "(none)";
	return items
		.map((item) => {
			const body = item.text.slice(0, item.source === "blog" ? MAX_BLOG_CHARS : MAX_MESSAGE_CHARS);
			return `### [${item.source}] ${item.label}\nid: ${item.id}\nat: ${item.at}\n${body}`;
		})
		.join("\n\n");
}

export function parseRssOrAtomItems(
	xml: string
): Array<{ guid: string; title: string; link: string; pubDate: string; description: string }> {
	const items: Array<{ guid: string; title: string; link: string; pubDate: string; description: string }> = [];
	const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
	for (const block of blocks) {
		const title = decodeXml(firstTag(block, "title") ?? "");
		const link = decodeXml(firstTag(block, "link") ?? hrefAttr(block) ?? "");
		const guid = decodeXml(firstTag(block, "guid") ?? firstTag(block, "id") ?? link);
		const pubDate = firstTag(block, "pubDate") ?? firstTag(block, "updated") ?? firstTag(block, "published") ?? "";
		const description = stripHtml(
			decodeXml(firstTag(block, "description") ?? firstTag(block, "summary") ?? firstTag(block, "content") ?? "")
		);
		if (!guid) continue;
		items.push({ guid, title, link, pubDate, description });
	}
	return items;
}

export function summarizeGithubEvent(event: GithubEvent): ReflectionSourceItem | null {
	const id = String(event.id ?? "");
	const at = String(event.created_at ?? "");
	const type = String(event.type ?? "Event");
	const repo = typeof event.repo?.name === "string" ? event.repo.name : "unknown-repo";
	if (!id || !at) return null;

	const payload = event.payload ?? {};
	let detail = type;
	if (type === "PushEvent") {
		const commits = Array.isArray(payload.commits) ? payload.commits : [];
		const messages = commits
			.map((commit) => (commit && typeof commit === "object" && "message" in commit ? String(commit.message) : ""))
			.filter(Boolean)
			.slice(0, 5);
		const ref = typeof payload.ref === "string" ? payload.ref.replace(/^refs\/heads\//, "") : "branch";
		detail = `push to ${ref}${messages.length ? `\n${messages.join("\n")}` : ""}`;
	} else if (type === "PullRequestEvent") {
		const action = typeof payload.action === "string" ? payload.action : "update";
		const pr = payload.pull_request && typeof payload.pull_request === "object" ? payload.pull_request : null;
		const title = pr && "title" in pr ? String(pr.title) : "";
		detail = `${action} PR${title ? `: ${title}` : ""}`;
	} else if (type === "IssuesEvent") {
		const action = typeof payload.action === "string" ? payload.action : "update";
		const issue = payload.issue && typeof payload.issue === "object" ? payload.issue : null;
		const title = issue && "title" in issue ? String(issue.title) : "";
		detail = `${action} issue${title ? `: ${title}` : ""}`;
	} else if (type === "ReleaseEvent") {
		const release = payload.release && typeof payload.release === "object" ? payload.release : null;
		const tag = release && "tag_name" in release ? String(release.tag_name) : "";
		detail = `release${tag ? ` ${tag}` : ""}`;
	} else if (type === "CreateEvent" || type === "DeleteEvent") {
		const refType = typeof payload.ref_type === "string" ? payload.ref_type : "ref";
		const ref = typeof payload.ref === "string" ? payload.ref : "";
		detail = `${type === "CreateEvent" ? "create" : "delete"} ${refType}${ref ? ` ${ref}` : ""}`;
	}

	return {
		source: "github",
		id,
		at,
		label: `${repo} · ${type}`,
		text: detail.slice(0, MAX_MESSAGE_CHARS),
	};
}

interface GithubEvent {
	id?: string | number;
	type?: string;
	created_at?: string;
	repo?: { name?: string };
	payload?: Record<string, unknown>;
}

function collectChatSources(
	workingDir: string,
	next: SourceCheckpoints,
	now: Date
): { items: ReflectionSourceItem[]; chatCount: number; bootstrapped: boolean } {
	const guids = listChatGuids(workingDir);
	const items: ReflectionSourceItem[] = [];
	let bootstrapped = false;

	for (const chatGuid of guids) {
		const messages = readChatLog(workingDir, chatGuid);
		if (!(chatGuid in next.chats)) {
			next.chats[chatGuid] = { processedLines: bootstrapProcessedLines(messages, now) };
			bootstrapped = true;
		}
		const processedLines = next.chats[chatGuid]?.processedLines ?? 0;
		const unprocessed = messages.slice(processedLines);
		if (unprocessed.length === 0) {
			next.chats[chatGuid] = { processedLines: messages.length };
			continue;
		}
		const lines = unprocessed.slice(0, MAX_CHAT_MESSAGES);
		for (const [offset, message] of lines.entries()) {
			items.push(chatItem(chatGuid, processedLines + offset, message));
		}
		next.chats[chatGuid] = { processedLines: processedLines + lines.length };
	}

	return { items, chatCount: guids.length, bootstrapped };
}

async function collectBlogSources(
	blogUrl: string,
	next: SourceCheckpoints,
	now: Date,
	fetchBlogFeed?: (url: string) => Promise<string>
): Promise<{ items: ReflectionSourceItem[]; bootstrapped: boolean }> {
	if (!blogUrl.trim()) return { items: [], bootstrapped: false };
	const xml = await (fetchBlogFeed ?? defaultFetchText)(blogUrl);
	const parsed = parseRssOrAtomItems(xml);
	const seen = new Set(next.blog.seenGuids);
	const firstRun = seen.size === 0;
	const fresh: ReflectionSourceItem[] = [];

	for (const item of parsed) {
		if (seen.has(item.guid)) continue;
		const at = toIsoDate(item.pubDate) ?? now.toISOString();
		fresh.push({
			source: "blog",
			id: item.guid,
			at,
			label: item.title || item.link || item.guid,
			text: [item.title, item.link, item.description].filter(Boolean).join("\n"),
		});
	}

	// Empty blog checkpoint: ingest every post currently in the feed (full history available via Atom/RSS).
	// Later runs keep a batch cap; only mark returned items seen so overflow can retry next run.
	const items = firstRun ? fresh : fresh.slice(0, MAX_BLOG_ITEMS);
	for (const item of items) {
		seen.add(item.id);
	}
	next.blog.seenGuids = trimSeen([...seen], 500);
	if (firstRun) {
		console.log(`[reflection] blog first run: ingesting ${items.length} historical posts from feed`);
	}
	return { items, bootstrapped: firstRun };
}

async function collectGithubSources(
	githubUser: string,
	next: SourceCheckpoints,
	now: Date,
	fetchGithubEvents?: (user: string) => Promise<unknown>
): Promise<{ items: ReflectionSourceItem[]; bootstrapped: boolean }> {
	if (!githubUser.trim()) return { items: [], bootstrapped: false };
	const payload = await (fetchGithubEvents ?? defaultFetchGithubEvents)(githubUser);
	if (!Array.isArray(payload)) throw new Error("GitHub events response was not an array");
	const seen = new Set(next.github.seenIds);
	const firstRun = seen.size === 0;
	const cutoff = now.getTime() - BOOTSTRAP_MS;
	const fresh: ReflectionSourceItem[] = [];

	for (const raw of payload) {
		if (!raw || typeof raw !== "object") continue;
		const item = summarizeGithubEvent(raw as GithubEvent);
		if (!item || seen.has(item.id)) continue;
		seen.add(item.id);
		if (firstRun && new Date(item.at).getTime() < cutoff) continue;
		fresh.push(item);
	}

	next.github.seenIds = trimSeen([...seen], 500);
	return { items: fresh.slice(0, MAX_GITHUB_EVENTS), bootstrapped: firstRun };
}

function chatItem(chatGuid: string, line: number, message: Message): ReflectionSourceItem {
	const speaker = message.fromAgent ? "bot" : message.sender;
	const text = (message.text ?? "[image]").slice(0, MAX_MESSAGE_CHARS);
	return {
		source: "chat",
		id: `${chatGuid}:${line}`,
		at: message.date,
		label: chatGuid,
		text: `${speaker}: ${text}`,
	};
}

function bootstrapProcessedLines(messages: Message[], now: Date): number {
	const cutoff = now.getTime() - BOOTSTRAP_MS;
	let processedLines = 0;
	while (processedLines < messages.length) {
		const message = messages[processedLines];
		if (!message || new Date(message.date).getTime() >= cutoff) break;
		processedLines += 1;
	}
	return processedLines;
}

function trimSeen(ids: string[], max: number): string[] {
	return ids.length <= max ? ids : ids.slice(ids.length - max);
}

function toIsoDate(value: string): string | null {
	if (!value.trim()) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString();
}

function firstTag(xml: string, tag: string): string | undefined {
	const cdata = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i").exec(xml);
	if (cdata?.[1] !== undefined) return cdata[1];
	const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
	return plain?.[1]?.trim();
}

function hrefAttr(xml: string): string | undefined {
	return /<link[^>]+href=["']([^"']+)["']/i.exec(xml)?.[1];
}

function decodeXml(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();
}

function stripHtml(value: string): string {
	return value
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

async function defaultFetchText(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			"user-agent": "pi-imessage-reflection/0.1",
			accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
	return response.text();
}

async function defaultFetchGithubEvents(user: string): Promise<unknown> {
	const response = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=30`, {
		headers: {
			"user-agent": "pi-imessage-reflection/0.1",
			accept: "application/vnd.github+json",
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Failed to fetch GitHub events for ${user}: HTTP ${response.status}`);
	return response.json();
}
