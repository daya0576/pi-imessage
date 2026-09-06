import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_CATEGORIES = [
	{ id: "chat", name: "聊天与社交" },
	{ id: "code", name: "代码与项目" },
	{ id: "mail", name: "邮件与通知" },
	{ id: "travel", name: "旅行与预订" },
	{ id: "calendar", name: "日历与联系人" },
	{ id: "knowledge", name: "文档与阅读" },
	{ id: "media", name: "照片与家庭记录" },
	{ id: "health", name: "健康与运动" },
	{ id: "finance", name: "财务与消费" },
	{ id: "home", name: "设备与生活习惯" },
] as const;
type Category = (typeof SOURCE_CATEGORIES)[number]["id"];
const PHASES = ["not_configured", "installed", "needs_authorization", "query_only", "scheduled"] as const;
const STATES = ["unknown", "blocked", "healthy", "stale", "failed"] as const;
const REASONS = [
	"screen_permission",
	"login_required",
	"collector_missing",
	"sync_unverified",
	"no_local_data",
	"sync_error",
] as const;
export type SourcePhase = (typeof PHASES)[number];
export type SourceState = (typeof STATES)[number];
export type SourceReason = (typeof REASONS)[number] | null;
interface SourceDefinition {
	id: string;
	name: string;
	category: Category;
	method: string;
	note: string;
	skill?: string;
	staleHours: number;
}
export const SOURCE_CATALOG: SourceDefinition[] = [
	{
		id: "wechat",
		name: "微信",
		category: "chat",
		method: "电脑客户端 + 待验证本地采集器",
		note: "登录、截图授权、聊天采集分别验证；安装客户端不代表已同步。",
		staleHours: 1,
	},
	{
		id: "messages",
		name: "iMessage / 短信",
		category: "chat",
		method: "本地 Messages 只读增量",
		note: "仅覆盖同步到此 Mac 的消息；成功时间是 Reflection checkpoint，不代表全量历史。",
		skill: "memory-reflection",
		staleHours: 30,
	},
	{
		id: "wechat-mp",
		name: "微信公众号文章",
		category: "chat",
		method: "已有文章监测工具",
		note: "公众号文章接口不是个人微信聊天接口；会话有效性需独立验证。",
		skill: "wx-mp-token-monitor",
		staleHours: 1,
	},
	{
		id: "github",
		name: "GitHub / 本地 Git",
		category: "code",
		method: "gh CLI / Git / 官方 API",
		note: "查询工具与自动事件采集不同；尚未配置完整历史与增量同步。",
		staleHours: 1,
	},
	{
		id: "mail",
		name: "电子邮件",
		category: "mail",
		method: "本地 Apple Mail；官方 API / IMAP 待接入",
		note: "本地读取器存在不代表邮箱已同步；没有独立邮件证据时显示未验证。",
		skill: "memory-reflection",
		staleHours: 30,
	},
	{
		id: "travel",
		name: "酒店 / 机票 / 火车票",
		category: "travel",
		method: "邮件、短信、PDF 派生",
		note: "尚未接通预订解析；未来须关联改期和取消，预订不等于实际入住。",
		staleHours: 1,
	},
	{
		id: "calendar",
		name: "日历 / 提醒事项 / 联系人",
		category: "calendar",
		method: "EventKit / CalDAV / 官方 API",
		note: "待授权；读取安排与修改安排使用不同权限。",
		staleHours: 1,
	},
	{
		id: "blog",
		name: "个人博客",
		category: "knowledge",
		method: "RSS/Atom 增量",
		note: "展示更新器的已持久化检查时间；不会因打开页面而访问博客或运行模型。",
		skill: "blog-memory-updater",
		staleHours: 16,
	},
	{
		id: "documents",
		name: "笔记 / PDF / 收藏 / 阅读",
		category: "knowledge",
		method: "文件索引 / 导出 / 服务 API",
		note: "尚未配置目录或账户；只索引明确选择的范围。",
		staleHours: 30,
	},
	{
		id: "immich",
		name: "Immich 相册",
		category: "media",
		method: "只读查询 + 夜间图片处理",
		note: "媒体保留在 Immich；显示图片处理 checkpoint，不表示所有视频已分析。",
		skill: "immich",
		staleHours: 30,
	},
	{
		id: "night-watcher",
		name: "Night Watcher",
		category: "media",
		method: "夜间采集 / 睡眠报告",
		note: "已有工作流；独立健康状态尚未桥接，页面不推断最近一次报告成功。",
		skill: "night-sleep-timelapse",
		staleHours: 30,
	},
	{
		id: "health",
		name: "健康 / 运动 / 体检",
		category: "health",
		method: "HealthKit 导出 / 报告导入",
		note: "待授权；家庭成员分别归档，原始健康数据不在此页面展示。",
		staleHours: 30,
	},
	{
		id: "finance",
		name: "账单 / 订单 / 保险",
		category: "finance",
		method: "官方导出 / 电子账单",
		note: "尚未接入账户；不采集支付密码或验证码。",
		staleHours: 30,
	},
	{
		id: "home-assistant",
		name: "Home Assistant",
		category: "home",
		method: "受限 CLI / 状态与历史查询",
		note: "已有 CLI；读取状态不等于持续采集，设备控制仍由独立权限约束。",
		skill: "home-assistant",
		staleHours: 1,
	},
	{
		id: "habits",
		name: "Beaver / 生活习惯",
		category: "home",
		method: "API 或导出（待配置）",
		note: "尚未接通习惯数据同步。",
		staleHours: 30,
	},
];
export interface SourceView extends Omit<SourceDefinition, "skill"> {
	phase: SourcePhase;
	state: SourceState;
	reason: SourceReason;
	checkedAt: string | null;
	lastSuccessAt: string | null;
	recordCount: number | null;
}
export interface SourcesData {
	categories: typeof SOURCE_CATEGORIES;
	sources: SourceView[];
	generatedAt: string;
}
function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function readObject(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	if (statSync(path).size > 8 * 1024 * 1024) throw new Error("Source metadata too large");
	const value = object(JSON.parse(readFileSync(path, "utf8")));
	if (!value) throw new Error("Invalid source metadata");
	return value;
}
function timestamp(value: unknown, now: number): string | null {
	if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value)) return null;
	const time = Date.parse(value);
	return Number.isFinite(time) && time <= now + 60_000 ? new Date(time).toISOString() : null;
}
function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function member<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && values.includes(value as T);
}

/** Read bounded, allowlisted status metadata only. No shell, credentials, message bodies or live connector calls. */
export function readSources(workingDir: string, now = Date.now()): SourcesData {
	const sources = SOURCE_CATALOG.map((definition): SourceView => {
		const { skill, ...publicDefinition } = definition;
		const configured = !!skill && existsSync(join(workingDir, "skills", skill, "SKILL.md"));
		const result: SourceView = {
			...publicDefinition,
			phase: configured ? "query_only" : "not_configured",
			state: "unknown",
			reason: configured ? "sync_unverified" : null,
			checkedAt: null,
			lastSuccessAt: null,
			recordCount: null,
		};
		try {
			// Connector/operator receipts contain only enums, timestamps and counts. They never include raw error text.
			const receipt = readObject(join(workingDir, "sources", "status", `${definition.id}.json`));
			if (receipt) {
				if (
					receipt.version !== 1 ||
					!member(PHASES, receipt.phase) ||
					!member(STATES, receipt.state) ||
					(receipt.reason !== null && !member(REASONS, receipt.reason))
				)
					throw new Error("Invalid receipt");
				result.phase = receipt.phase;
				result.state = receipt.state;
				result.reason = receipt.reason as SourceReason;
				result.checkedAt = timestamp(receipt.checkedAt, now);
				result.lastSuccessAt = timestamp(receipt.lastSuccessAt, now);
				result.recordCount = count(receipt.recordCount);
				if (!result.checkedAt) throw new Error("Receipt missing valid observation time");
			}
			// Existing workflows are bridged through verified checkpoint formats, without modifying those workflows.
			if (definition.id === "blog" && !receipt) {
				const state = readObject(join(workingDir, "skills", "blog-memory-updater", "state-v2.json"));
				if (state?.version === 2 && Array.isArray(state.processed_urls) && typeof state.last_check === "string") {
					// Legacy updater writes local Shanghai time without an offset.
					const checked = timestamp(
						/(Z|[+-]\d\d:\d\d)$/.test(state.last_check) ? state.last_check : `${state.last_check}+08:00`,
						now
					);
					result.phase = "scheduled";
					result.checkedAt = checked;
					result.recordCount = state.processed_urls.length;
					if (Array.isArray(state.last_failures) && state.last_failures.length) {
						result.state = "failed";
						result.reason = "sync_error";
					} else if (checked && Array.isArray(state.last_failures)) {
						result.lastSuccessAt = checked;
						result.state = "healthy";
						result.reason = null;
					}
				}
			}
			// Paths are selected from reviewed metadata, never supplied by a URL query.
			if (["messages", "immich"].includes(definition.id) && !receipt) {
				const bridge = readObject(join(workingDir, "sources", "reflection-bridge.json"));
				const chat = bridge?.chatDirectory;
				if (typeof chat === "string" && /^iMessage;[+-];[a-zA-Z0-9+_-]+$/.test(chat)) {
					const state = readObject(
						join(
							workingDir,
							chat,
							"scratch",
							"memory-reflection",
							definition.id === "messages" ? "checkpoint.json" : "immich-checkpoint.json"
						)
					);
					const valid =
						definition.id === "messages"
							? state?.version === 2 && count(object(state.sources)?.messagesDbRowId) !== null
							: state?.version === 1 && Array.isArray(state.seenAssetIds);
					if (state && valid) {
						result.phase = "scheduled";
						result.lastSuccessAt = timestamp(state.updatedAt, now);
						result.checkedAt = result.lastSuccessAt;
						result.state = result.lastSuccessAt ? "healthy" : "unknown";
						result.reason = result.lastSuccessAt ? null : "sync_unverified";
						if (definition.id === "immich" && Array.isArray(state.seenAssetIds))
							result.recordCount = state.seenAssetIds.length;
					}
				}
			}
		} catch {
			// Never reflect parser errors, file paths or arbitrary source content to the web page or logs.
			result.state = "failed";
			result.reason = "sync_error";
			result.checkedAt = null;
			result.lastSuccessAt = null;
			result.recordCount = null;
		}
		if (
			result.state === "healthy" &&
			(result.phase !== "scheduled" ||
				!result.lastSuccessAt ||
				!result.checkedAt ||
				Date.parse(result.lastSuccessAt) > Date.parse(result.checkedAt))
		) {
			result.state = "unknown";
			result.reason = "sync_unverified";
		}
		const freshness = result.state === "healthy" ? result.lastSuccessAt : result.checkedAt;
		if (
			["healthy", "blocked"].includes(result.state) &&
			freshness &&
			now - Date.parse(freshness) > definition.staleHours * 3_600_000
		)
			result.state = "stale";
		return result;
	});
	return { categories: SOURCE_CATEGORIES, sources, generatedAt: new Date(now).toISOString() };
}
