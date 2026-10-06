/** Safe, transport-independent progress data; never include raw outputs or commands. */
export type ProgressEvent = {
	type: "tool" | "task";
	parents: readonly string[];
	name: string;
} & (
	| { phase: "request"; summary?: string; commandPreview?: string }
	| { phase: "response"; success: boolean; elapsedMs: number }
);

/** The plain-text adapter; apps can render the same fields without parsing this text. */
export function formatProgress(event: ProgressEvent) {
	const prefix = event.parents.length ? `${event.parents.join("/")}/` : "";
	const header = `[${prefix}${event.type}]`;
	if (event.phase === "response") {
		return `${event.success ? "✓" : "×"} ${header} ${event.name} (${(event.elapsedMs / 1000).toFixed(1)}s)`;
	}
	const summary =
		event.type === "tool" ? (event.name === "bash" ? event.commandPreview : event.summary) : undefined;
	return `→ ${header} ${event.name}${summary ? `: ${summary}` : ""}`;
}

/** Screen the whole command before showing a bounded, non-clickable preview. */
export function commandPreview(command: unknown) {
	if (typeof command !== "string") return "[command hidden]";
	// Match a complete shell word, including concatenated quotes and escaped spaces.
	const word = String.raw`(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\$\([\s\S]*\)|\x60(?:\\[\s\S]|[^\x60\\])*\x60|\\[\s\S]|[^\s;|&<>"'\\\x60])+`;
	const key = String.raw`[\w.-]*(?:secret|token|password|passwd|credential|authorization|api[._-]?key|private[._-]?key|bearer)[\w.-]*`;
	let maskNext = false;
	const screened = command
		.replace(/\\\r?\n/g, "")
		.replace(/-----BEGIN[^\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\r\n]*PRIVATE KEY-----|$)/g, "***")
		.replace(/\b(?:sk-[a-z0-9_-]+|gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+)\b/gi, "***")
		.replace(/(https?:\/\/)[^\s/<>]+@/gi, "$1***@")
		.replace(new RegExp(word, "g"), (argument) => {
			if (maskNext) {
				maskNext = false;
				return "***";
			}
			const option = argument.replace(/["']/g, "");
			if (new RegExp(`^(?:--${key}|--user|-u|bearer)$`, "i").test(option)) {
				maskNext = true;
				return argument;
			}
			// Headers can concatenate quoted/unquoted fragments in one shell word.
			if (/\b(?:proxy-)?authorization\s*:/i.test(argument)) {
				const quote = /^["']/.test(argument) && argument.at(-1) === argument[0] ? argument[0] : "";
				return argument.replace(/(\b(?:proxy-)?authorization\s*:\s*)[\s\S]*/i, "$1***") + quote;
			}
			// Escaped JSON is an opaque shell argument; don't expose partial values.
			if (new RegExp(String.raw`\\["']${key}\\["']\s*:`, "i").test(argument)) return "***";
			return argument
				.replace(
					new RegExp(String.raw`(["']${key}["']\s*:\s*)("(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\s,}\]]+)`, "gi"),
					(_match, prefix: string, value: string) =>
						`${prefix}${/^["']/.test(value) ? `${value[0]}***${value[0]}` : "***"}`,
				)
				.replace(new RegExp(String.raw`((?:\b${key}|--user)\s*[=:]\s*)[\s\S]*`, "gi"), "$1***")
				.replace(/(\bbearer\s+)[\s\S]*/gi, "$1***");
		})
		.replace(/\s+/g, " ")
		.trim()
		.replace(/https?:\/\/[^\s"'`<>]+/gi, (url) =>
			url.replaceAll(":", "：").replaceAll("/", "／").replaceAll(".", "．"),
		)
		.replace(
			/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|cn|io|dev|app|co|edu|gov|uk|us)\b/gi,
			(host) => host.replaceAll(".", "．"),
		);
	const characters = Array.from(screened);
	return characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : screened;
}

/** Argument previews for non-bash tools; bash requests show only `commandPreview`. */
export function argumentSummary(arguments_: Record<string, unknown>) {
	return Object.entries(arguments_)
		.filter(([key]) => key !== "timeout")
		.map(([key, value]) => {
			if (/secret|token|password|credential|authorization|api.?key/i.test(key)) return `${key}=[redacted]`;
			if (typeof value === "number" || typeof value === "boolean") return `${key}=${value}`;
			if (typeof value === "string") {
				if (["path", "filePath", "cwd", "query"].includes(key)) {
					if (
						/secret|token|password|credential|authorization|api.?key|sk-[a-z0-9]|gh[pousr]_|github_pat_|bearer\s|https?:\/\/\S+@/i.test(
							value,
						)
					)
						return `${key}=[redacted]`;
					return `${key}=${value
						.replace(/https?:\/\/\S+/gi, "[link omitted]")
						.replace(/[\r\n\t]/g, " ")
						.slice(0, 160)}`;
				}
				if (key === "url") {
					try {
						const url = new URL(value);
						return `${key}=${url.hostname.replaceAll(".", "．")}`;
					} catch {
						return `${key}=[${value.length} chars]`;
					}
				}
				return `${key}=[${value.length} chars]`;
			}
			return `${key}=[${Array.isArray(value) ? `${value.length} items` : "object"}]`;
		})
		.join(", ")
		.slice(0, 400);
}
