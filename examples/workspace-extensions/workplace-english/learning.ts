import type * as FileSystem from "node:fs/promises";

const { readFile } = require("node:fs/promises") as typeof FileSystem;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type LearningEntry = JsonObject & {
	date: string;
	expressions: string[];
	paragraph?: string;
};
type Review = JsonObject & { completedDays: number[]; lastReviewedOn?: string };
export type LearningHistory = JsonObject & {
	entries: LearningEntry[];
	reviews: Record<string, Review>;
};
export type EnglishPlan = {
	date: string;
	reviews: { key: string; expression: string; date: string; paragraph: string; due: number[] }[];
	newExpression: boolean;
	used: string[];
};
export type EnglishAnswer = {
	reviews: { expression: string; meaning: string }[];
	newExpression: { expression: string; meaning: string; paragraph: string } | null;
};
const DAY = 86400000;
export type LearningPolicy = {
	reviewIntervals: number[];
	effectiveFrom: string;
	maxReviews: number;
	dailyLimit: number;
	windowDays: number;
	maxNew: number;
	minNewGapDays: number;
};

function dayNumber(date: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)))
		throw new Error("Invalid learning date");
	return Date.parse(`${date}T00:00:00Z`) / DAY;
}

function normalized(expression: string) {
	return expression.trim().toLowerCase();
}

/** Import once, retaining unknown fields. Never write back to the legacy source. */
async function readLearningHistory(path: string, policy: LearningPolicy): Promise<LearningHistory> {
	const raw: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid learning history");
	const value = raw as Record<string, unknown>;
	if (!Array.isArray(value.entries)) throw new Error("Learning entries are missing");
	for (const entry of value.entries) {
		if (!entry || typeof entry !== "object" || typeof entry.date !== "string")
			throw new Error("Invalid learning entry");
		dayNumber(entry.date);
		if (
			!Array.isArray(entry.expressions) ||
			!entry.expressions.every((item: unknown) => typeof item === "string" && item.trim())
		)
			throw new Error("Invalid learned expressions");
		if (entry.paragraph !== undefined && typeof entry.paragraph !== "string")
			throw new Error("Invalid original paragraph");
	}
	const reviews = value.reviews ?? {};
	if (!reviews || typeof reviews !== "object" || Array.isArray(reviews)) throw new Error("Invalid reviews");
	for (const review of Object.values(reviews)) {
		if (
			!review ||
			typeof review !== "object" ||
			!Array.isArray(review.completedDays) ||
			!review.completedDays.every(
				(day: unknown) => typeof day === "number" && policy.reviewIntervals.includes(day),
			)
		)
			throw new Error("Invalid review progress");
		if (review.lastReviewedOn !== undefined) dayNumber(review.lastReviewedOn);
	}
	return { ...value, reviews } as LearningHistory;
}

/** Policy is deterministic; the model cannot choose quotas or mark unseen reviews completed. */
function planEnglish(history: LearningHistory, date: string, policy: LearningPolicy): EnglishPlan {
	const today = dayNumber(date);
	const unique = new Map<string, { entry: LearningEntry; expression: string; order: number }>();
	for (const entry of [...history.entries].sort((a, b) => a.date.localeCompare(b.date))) {
		for (const expression of entry.expressions) {
			const key = normalized(expression);
			if (!unique.has(key)) unique.set(key, { entry, expression, order: unique.size });
		}
	}
	const candidates = [...unique.values()]
		.flatMap(({ entry, expression, order }) => {
			const key = `${entry.date}|${normalized(expression)}`;
			const progress = history.reviews[key];
			const elapsed = today - dayNumber(entry.date);
			const due = policy.reviewIntervals.filter(
				(day) => day <= elapsed && !progress?.completedDays.includes(day),
			);
			if (!due.length || progress?.lastReviewedOn === date) return [];
			return [{ key, expression, date: entry.date, paragraph: entry.paragraph ?? "", due, order }];
		})
		.sort(
			(a, b) =>
				dayNumber(a.date) + a.due[0] - (dayNumber(b.date) + b.due[0]) ||
				a.date.localeCompare(b.date) ||
				a.order - b.order,
		);
	const reviews = candidates.slice(0, policy.maxReviews).map(({ order: _order, ...review }) => review);
	const recentNew = [...unique.values()].filter(
		({ entry }) =>
			entry.date >= policy.effectiveFrom &&
			today - dayNumber(entry.date) >= 0 &&
			today - dayNumber(entry.date) < policy.windowDays,
	);
	const latestNew = recentNew.reduce((last, { entry }) => Math.max(last, dayNumber(entry.date)), -Infinity);
	return {
		date,
		reviews,
		newExpression:
			date >= policy.effectiveFrom &&
			reviews.length < policy.dailyLimit &&
			recentNew.length < policy.maxNew &&
			today - latestNew >= policy.minNewGapDays &&
			!history.entries.some((entry) => entry.date === date),
		used: [...unique.keys()],
	};
}

function englishPrompt(plan: EnglishPlan) {
	return [
		'Return only JSON, no Markdown: {"reviews":[{"expression":"...","meaning":"concise Chinese meaning"}],"newExpression":null or {"expression":"...","meaning":"concise Chinese meaning","paragraph":"short natural English workplace dialogue containing the expression"}}.',
		"Use exactly the requested reviews, in order. Never rewrite their original paragraphs. Do not invent facts about the learner.",
		plan.newExpression
			? "Choose ONE idiomatic, high-frequency spoken workplace expression never seen in used. Prefer practical cross-team language that can be said aloud directly."
			: "No new expression is permitted; newExpression must be null.",
		JSON.stringify({ reviews: plan.reviews.map((review) => review.expression), used: plan.used }),
	].join("\n");
}

function parseEnglishAnswer(text: string, plan: EnglishPlan): EnglishAnswer {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid English card JSON");
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.reviews) || raw.reviews.length !== plan.reviews.length)
		throw new Error("English review count differs from the plan");
	const reviews = raw.reviews.map((review: unknown, index: number) => {
		if (!review || typeof review !== "object") throw new Error("Invalid English review");
		const item = review as Record<string, unknown>;
		if (
			item.expression !== plan.reviews[index].expression ||
			typeof item.meaning !== "string" ||
			!item.meaning.trim()
		)
			throw new Error("English review differs from the plan");
		return { expression: plan.reviews[index].expression, meaning: item.meaning.trim() };
	});
	let newExpression: EnglishAnswer["newExpression"] = null;
	if (plan.newExpression) {
		if (!raw.newExpression || typeof raw.newExpression !== "object" || Array.isArray(raw.newExpression))
			throw new Error("New English expression is missing");
		const item = raw.newExpression as Record<string, unknown>;
		if (
			typeof item.expression !== "string" ||
			!item.expression.trim() ||
			typeof item.meaning !== "string" ||
			!item.meaning.trim() ||
			typeof item.paragraph !== "string" ||
			!item.paragraph.trim() ||
			!item.paragraph.toLowerCase().includes(normalized(item.expression)) ||
			plan.used.includes(normalized(item.expression))
		)
			throw new Error("Invalid or repeated new English expression");
		newExpression = {
			expression: item.expression.trim(),
			meaning: item.meaning.trim(),
			paragraph: item.paragraph.trim(),
		};
	} else if (raw.newExpression !== null) throw new Error("Unplanned new English expression");
	return { reviews, newExpression };
}

/** Apply only displayed expressions; the caller commits this and the outbox in one transaction. */
function applyEnglish(history: LearningHistory, plan: EnglishPlan, answer: EnglishAnswer) {
	const lines = [plan.date];
	if (answer.newExpression) {
		const { expression, meaning, paragraph } = answer.newExpression;
		lines.push("今日新表达", `- ${expression} — ${meaning}`, paragraph);
		history.entries.push({
			date: plan.date,
			expressions: [expression],
			paragraph,
			meanings: { [expression]: meaning },
		});
	}
	if (plan.reviews.length) {
		lines.push("今日复习");
		const groups = new Map<string, typeof plan.reviews>();
		for (const [index, review] of plan.reviews.entries()) {
			const progress = history.reviews[review.key] ?? { completedDays: [] };
			history.reviews[review.key] = {
				...progress,
				completedDays: [...new Set([...progress.completedDays, ...review.due])].sort((a, b) => a - b),
				lastReviewedOn: plan.date,
			};
			const key = `${review.date}|${review.paragraph}`;
			if (!groups.has(key)) groups.set(key, []);
			groups
				.get(key)
				?.push({ ...review, expression: `- ${review.expression} — ${answer.reviews[index].meaning}` });
		}
		for (const group of groups.values()) {
			lines.push(
				`首次学习：${group[0].date}`,
				...group.map((review) => review.expression),
				group[0].paragraph || "原文段落未找回",
			);
		}
	}
	if (!answer.newExpression && !plan.reviews.length) lines.push("今天休息，没有新学或到期复习。");
	return lines.join("\n");
}

export type EnglishFunctions = {
	readLearningHistory: typeof readLearningHistory;
	planEnglish: typeof planEnglish;
	englishPrompt: typeof englishPrompt;
	parseEnglishAnswer: typeof parseEnglishAnswer;
	applyEnglish: typeof applyEnglish;
};
module.exports = { readLearningHistory, planEnglish, englishPrompt, parseEnglishAnswer, applyEnglish };
