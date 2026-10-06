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
	if (
		/secret|token|password|passwd|credential|authorization|api.?key|private.?key|bearer\s|sk-[a-z0-9]|gh[pousr]_|github_pat_|\.env\b|auth\.json|id_(rsa|ed25519)|BEGIN.*PRIVATE KEY|https?:\/\/\S+@|(?:--user|-u)\s/i.test(
			command,
		)
	)
		return "[command hidden: sensitive content]";
	const screened = command
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

/** Short purpose labels and query previews are screened separately from commands. */
export function argumentSummary(arguments_: Record<string, unknown>, toolName?: string) {
	const purpose = arguments_.description;
	const label =
		toolName === "bash"
			? typeof purpose === "string" &&
				!/secret|token|password|credential|authorization|api.?key|sk-[a-z0-9]|gh[pousr]_|github_pat_|bearer\s|https?:|@/i.test(
					purpose,
				)
				? purpose.replace(/[\r\n\t]/g, " ").slice(0, 80)
				: "执行命令"
			: "";
	const summary = Object.entries(arguments_)
		.filter(
			([key]) => key !== "timeout" && (toolName !== "bash" || !["command", "description"].includes(key)),
		)
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
	return [label, summary].filter(Boolean).join(" · ");
}
