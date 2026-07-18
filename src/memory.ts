import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StructuredMemoryItem {
	id: string;
	text: string;
	category: string;
	subjects: string[];
	event_time: string;
	importance: number;
	confidence: number;
	status: "active" | "superseded";
	supersedes_id?: string;
}

const CATEGORIES = ["person", "preference", "event", "health", "work_project", "procedure"] as const;
const SUBJECT_ALIASES: Record<string, string[]> = {
	Henry: ["henry", "大牙", "朱昌健"],
	CC: ["cc"],
	派派: ["派派", "小乖", "帅萌", "小帅萌"],
};
const CATEGORY_TERMS: Record<string, string[]> = {
	health: [
		"生病",
		"发烧",
		"退烧",
		"体温",
		"咳嗽",
		"鼻涕",
		"感染",
		"病毒",
		"肺炎",
		"住院",
		"出院",
		"医生",
		"药",
		"检查",
		"报告",
		"血常规",
		"crp",
		"saa",
	],
	work_project: ["工作", "公司", "项目", "optiver", "github", "pi-imessage", "homelab", "sre"],
	preference: ["喜欢", "不喜欢", "偏好", "希望"],
	procedure: ["应该怎么", "规则", "原则", "必须", "以后", "排查", "流程"],
	person: ["是谁", "姓名", "出生", "现居", "家庭", "妻子", "儿子"],
	event: ["发生", "当时", "最近", "上次", "什么时候"],
};

function memoryRoot(workingDir: string): string {
	return join(workingDir, "skills", "file-memory");
}

export function readCoreMemory(workingDir: string): string {
	const path = join(memoryRoot(workingDir), "core.md");
	if (!existsSync(path)) return "(no core memory yet)";
	try {
		return readFileSync(path, "utf8").trim() || "(no core memory yet)";
	} catch (error) {
		console.warn(`[memory] failed to read core memory: ${error}`);
		return "(core memory unavailable)";
	}
}

export function loadStructuredMemories(workingDir: string): StructuredMemoryItem[] {
	const items: StructuredMemoryItem[] = [];
	for (const category of CATEGORIES) {
		const path = join(memoryRoot(workingDir), "categories", `${category}.jsonl`);
		if (!existsSync(path)) continue;
		try {
			for (const [index, raw] of readFileSync(path, "utf8").split("\n").entries()) {
				if (!raw.trim()) continue;
				try {
					items.push(JSON.parse(raw) as StructuredMemoryItem);
				} catch (error) {
					console.warn(`[memory] invalid JSONL ${path}:${index + 1}: ${error}`);
				}
			}
		} catch (error) {
			console.warn(`[memory] failed to read ${path}: ${error}`);
		}
	}
	return items;
}

function activeMemories(items: StructuredMemoryItem[]): StructuredMemoryItem[] {
	const supersededIds = new Set(
		items.filter((item) => item.status === "active" && item.supersedes_id).map((item) => item.supersedes_id as string)
	);
	return items.filter((item) => item.status === "active" && !supersededIds.has(item.id));
}

function matchedSubjects(query: string): string[] {
	const low = query.toLowerCase();
	const result: string[] = [];
	for (const [subject, aliases] of Object.entries(SUBJECT_ALIASES)) {
		if (aliases.some((alias) => low.includes(alias))) result.push(subject);
	}
	if (result.length === 0 && /(^|[\s])我(的|们|感觉|觉得|想|不|要|是|有|在|会|能|就|也|还|最近|今天)/.test(query)) {
		if (query.includes("from +8617612150403")) result.push("Henry");
		if (query.includes("from +8618930176019")) result.push("CC");
	}
	return result;
}

function matchedCategories(query: string): string[] {
	const low = query.toLowerCase();
	return Object.entries(CATEGORY_TERMS)
		.filter(([, terms]) => terms.some((term) => low.includes(term)))
		.map(([category]) => category);
}

function queryTerms(query: string): string[] {
	const low = query.toLowerCase();
	const knownTerms = [
		...new Set(
			Object.values(CATEGORY_TERMS)
				.flat()
				.filter((term) => low.includes(term))
		),
	];
	const latinTerms = low.match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? [];
	const chineseStopBigrams = new Set(["我们", "他们", "什么", "怎么", "现在", "最近", "时候", "上次", "今天"]);
	const chineseBigrams: string[] = [];
	for (const sequence of low.match(/[\p{Script=Han}]{3,}/gu) ?? []) {
		for (let index = 0; index < sequence.length - 1; index += 1) {
			const bigram = sequence.slice(index, index + 2);
			if (!chineseStopBigrams.has(bigram)) chineseBigrams.push(bigram);
		}
	}
	return [...new Set([...knownTerms, ...latinTerms, ...chineseBigrams])];
}

export function retrieveStructuredMemory(workingDir: string, query: string, limit = 8): StructuredMemoryItem[] {
	const content = query.replace(/^\[(?:DM|SMS|Group)[^\]]*\]\s*/i, "").replace(/^\[replying to:[^\]]*\]\s*/i, "");
	const subjects = matchedSubjects(content).length > 0 ? matchedSubjects(content) : matchedSubjects(query);
	const categories = matchedCategories(content);
	const terms = queryTerms(content);
	if (subjects.length === 0 && categories.length === 0 && terms.length === 0) return [];

	const now = Date.now();
	const scored: Array<{ item: StructuredMemoryItem; score: number }> = [];
	const seenText = new Set<string>();
	for (const item of activeMemories(loadStructuredMemories(workingDir))) {
		if (subjects.length > 0 && !subjects.some((subject) => item.subjects.includes(subject))) continue;
		const normalizedText = item.text.replace(/\s+/g, "").toLowerCase();
		if (seenText.has(normalizedText)) continue;
		const categoryMatch = categories.includes(item.category) ? 1 : 0;
		const lexical = terms.filter((term) => normalizedText.includes(term)).length;
		const subjectMatch = subjects.filter((subject) => item.subjects.includes(subject)).length;
		if (categoryMatch === 0 && lexical === 0 && subjectMatch === 0) continue;
		const timestamp = Date.parse(`${item.event_time}T00:00:00Z`);
		const ageDays = Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 86_400_000) : 365;
		const recency = 1 / (1 + ageDays / 30);
		const score = lexical * 3 + subjectMatch * 2 + categoryMatch * 2 + item.importance + item.confidence + recency;
		scored.push({ item, score });
		seenText.add(normalizedText);
	}
	return scored
		.sort((a, b) => b.score - a.score || b.item.event_time.localeCompare(a.item.event_time))
		.slice(0, limit)
		.map(({ item }) => item);
}

export function formatStructuredMemory(items: StructuredMemoryItem[]): string {
	if (items.length === 0) return "";
	const lines = items.map(
		(item) =>
			`- ${item.event_time} | ${item.category} | ${item.subjects.join(",") || "unspecified"} | ${item.id} | ${item.text}`
	);
	return `Relevant structured memory (retrieved automatically; active records only):\n${lines.join("\n")}`;
}
