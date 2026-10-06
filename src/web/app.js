const page = location.pathname === "/" ? "/chat" : location.pathname;
const conversationId = new URLSearchParams(location.search).get("conversationId");
const view = document.getElementById("view");
const toolbar = document.getElementById("toolbar");
const notice = document.getElementById("notice");
const state = document.getElementById("state");
const main = document.getElementById("main");
const sidebar = document.getElementById("chat-list");
document.getElementById("connection")?.remove();
let data = JSON.parse(state.textContent);
let chats = [];
let memoryQuery = { q: "", namespace: "", kind: "", status: "active", page: 1 };
let refreshing = false;

document.body.classList.add(`page-${page.slice(1)}`);
if (conversationId) document.body.classList.add("conversation-detail");
document.getElementById("title").textContent =
	{
		"/chat": "Recent Chats",
		"/tasks": "Tasks",
		"/scheduled": "Scheduled tasks",
		"/logs": "Logs",
		"/memory": "Memory / 记忆与规则",
		"/settings": "Settings",
	}[page] || "pi-imessage";

function element(tag, text, className) {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = String(text);
	if (className) node.className = className;
	return node;
}

function link(text, href, className) {
	const node = element("a", text, className);
	node.href = href;
	return node;
}

function showNotice(text) {
	notice.textContent = text;
	notice.hidden = !text;
}

async function fetchData(url) {
	const response = await fetch(url, { cache: "no-store" });
	if (!response.ok) throw new Error(`Unable to load ${url.split("?")[0]} (${response.status})`);
	return response.json();
}

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "image") return "[Image attachment]";
			if (block.type === "toolCall") return `[Tool: ${block.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function messages(detail, chatGuid) {
	return (detail.history?.items || [])
		.flatMap((entry) =>
			(entry.model || [])
				.filter((message) => ["user", "assistant"].includes(message.role) && message.stopReason !== "toolUse")
				.map((message) => {
					const original = entry.data?.original || {};
					const content = messageText(message.content);
					const prefix = content.match(/^\[(?:Group '([^']*)'|DM|SMS) from ([^\]]+)\] /);
					const sender =
						message.role === "assistant"
							? "pi"
							: original.senderName || original.sender || prefix?.[2] || "user";
					return {
						id: `${entry.id}-${message.role}`,
						time: Number(message.timestamp) || Date.parse(original.date) || 0,
						role: message.role,
						status:
							message.role === "assistant" && !entry.data?.legacy
								? detail.delivery?.drafts?.[entry.id]?.status ||
									detail.delivery?.answers?.[entry.id] ||
									"pending"
								: undefined,
						sender,
						groupName: original.groupName || prefix?.[1],
						text: prefix ? content.slice(prefix[0].length) : content,
						channel: chatGuid.includes(";+;") ? "GROUP" : chatGuid.startsWith("SMS;") ? "SMS" : "DM",
					};
				}),
		)
		.filter((message) => message.text)
		.sort((left, right) => left.time - right.time);
}

function formatTime(timestamp) {
	if (!timestamp) return "[unknown time]";
	const date = new Date(timestamp);
	const parts = [
		date.getMonth() + 1,
		date.getDate(),
		date.getHours(),
		date.getMinutes(),
		date.getSeconds(),
	].map((value) => String(value).padStart(2, "0"));
	return `[${date.getFullYear()}-${parts[0]}-${parts[1]} ${parts[2]}:${parts[3]}:${parts[4]}]`;
}

function chatName(chat, rows) {
	const named = rows.findLast((row) => row.groupName);
	if (named) return named.groupName;
	if (chat.history?.groupName) return chat.history.groupName;
	if (chat.chatGuid.includes(";+;")) return `Group ${chat.chatGuid.split(";").at(-1).replace(/^chat/, "")}`;
	return chat.chatGuid.split(";").at(-1) || `Conversation ${chat.conversationId}`;
}

function compareConversations(left, right) {
	const leftActivity = left.updatedAt ?? left.rows?.at(-1)?.time ?? 0;
	const rightActivity = right.updatedAt ?? right.rows?.at(-1)?.time ?? 0;
	return (
		rightActivity - leftActivity || (right.conversationId ?? right.id) - (left.conversationId ?? left.id)
	);
}

function replyEnabled(settings, chatGuid) {
	const { whitelist = [], blacklist = [] } = settings.chatAllowlist || {};
	if (blacklist.includes(chatGuid)) return false;
	if (whitelist.includes(chatGuid)) return true;
	return !blacklist.includes("*") && whitelist.includes("*");
}

function chatCard(chat, full, expanded) {
	const card = element("section", undefined, "card");
	card.id = `chat-${chat.conversationId}`;
	const header = element("header", undefined, "card-header");
	const heading = element("span");
	heading.append(link(chat.name, `/chat?conversationId=${chat.conversationId}`));
	heading.append(element("span", `  ${chat.rows.length} recent msgs  `, "meta"));
	heading.append(link("Task tree", `/tasks?conversationId=${chat.conversationId}`, "meta"));
	header.append(heading);
	const reply = element("span", chat.enabled ? "[on]" : "[off]", "reply-state");
	reply.title = "Reply allowlist status (read-only). Change settings.json to update it.";
	header.append(reply);
	card.append(header);
	const body = element("div", undefined, "card-messages");
	if (chat.error) body.append(element("p", chat.error, "muted"));
	else if (!chat.rows.length) body.append(element("p", "No messages yet.", "empty"));
	else {
		const table = element("table");
		table.setAttribute("aria-label", `Messages in ${chat.name}`);
		const rows = full
			? chat.rows
			: chat.rows.filter(
					(message, index) =>
						index >= chat.rows.length - 15 || expanded.has(`message-${chat.conversationId}-${message.id}`),
				);
		let previousTime;
		for (const message of rows) {
			if (previousTime && message.time - previousTime > 10 * 60 * 1000) {
				const gap = table.insertRow().insertCell();
				gap.colSpan = 6;
				gap.textContent = "\u00a0";
			}
			previousTime = message.time;
			const row = table.insertRow();
			for (const [text, className] of [
				[formatTime(message.time), "c-time"],
				["[sid]", "c-source"],
				[message.role === "assistant" ? "->" : "<-", "c-arrow"],
				[`[${message.channel}]`, "c-channel"],
				[`${message.sender}:`, "c-sender"],
			]) {
				row.append(element("td", text, `c-fix ${className}`));
			}
			const cell = element("td", undefined, "c-msg");
			const detail = element("details", undefined, "message-detail");
			detail.id = `message-${chat.conversationId}-${message.id}`;
			const firstLine = message.text.split("\n").find((line) => line.trim()) || "[Empty message]";
			const summary = element("summary", firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine);
			if (message.status && message.status !== "sent") {
				const status = element("span", `[${message.status}] `, "meta");
				status.title = "Transport receipt / draft status; this is not confirmed as sent.";
				summary.prepend(status);
			}
			detail.append(summary);
			detail.append(element("pre", message.text));
			cell.append(detail);
			row.append(cell);
		}
		body.append(table);
	}
	card.append(body);
	return card;
}

function renderChats() {
	const expanded = new Set(Array.from(view.querySelectorAll("details[open]"), (node) => node.id));
	const positions = new Map(
		Array.from(view.querySelectorAll(".card"), (card) => {
			const body = card.querySelector(".card-messages");
			return [
				card.id,
				{ top: body.scrollTop, bottom: body.scrollHeight - body.scrollTop - body.clientHeight < 20 },
			];
		}),
	);
	view.replaceChildren();
	sidebar.replaceChildren();
	sidebar.hidden = false;
	if (!chats.length) view.append(element("p", "No conversations.", "empty"));
	for (const chat of chats) {
		const card = chatCard(chat, Boolean(conversationId), expanded);
		view.append(card);
		for (const detail of card.querySelectorAll("details")) detail.open = expanded.has(detail.id);
		if (!conversationId) {
			const body = card.querySelector(".card-messages");
			const previous = positions.get(card.id);
			body.scrollTop = !previous || previous.bottom ? body.scrollHeight : previous.top;
		}
		sidebar.append(link(chat.name, `#chat-${chat.conversationId}`));
	}
	if (conversationId && data.history?.next) {
		const next = new URL(location.href);
		const bytes = new TextEncoder().encode(JSON.stringify(data.history.next));
		next.searchParams.set(
			"cursor",
			btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, ""),
		);
		view.append(link("Older messages >", next.pathname + next.search, "pagination"));
	}
}

async function loadChats() {
	if ((!conversationId && Array.isArray(data.conversations)) || (conversationId && data.chat)) {
		const selected = conversationId ? [{ ...data, ...data.chat }] : data.conversations;
		chats = selected
			.map((detail) => {
				const rows = messages(detail, detail.chatGuid);
				return {
					...detail,
					rows,
					name: chatName(detail, rows),
					enabled: replyEnabled(data.settings, detail.chatGuid),
				};
			})
			.sort(compareConversations);
		renderChats();
		return;
	}
	// Older running servers still return native state until their next restart.
	const [index, settings] = await Promise.all([
		conversationId ? fetchData("/chat/data") : Promise.resolve(data),
		fetchData("/settings/data"),
	]);
	const selected = (index.chats?.items || []).filter(
		(chat) => !conversationId || String(chat.conversationId) === conversationId,
	);
	const loaded = [];
	let offset = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, selected.length) }, async () => {
			while (offset < selected.length) {
				const chat = selected[offset++];
				try {
					const detail = conversationId
						? data
						: await fetchData(`/chat/data?conversationId=${chat.conversationId}`);
					const rows = messages(detail, chat.chatGuid);
					loaded.push({
						...chat,
						rows,
						name: chatName(chat, rows),
						enabled: replyEnabled(settings, chat.chatGuid),
					});
				} catch (error) {
					loaded.push({ ...chat, rows: [], name: chatName(chat, []), error: error.message });
				}
			}
		}),
	);
	chats = loaded.sort(compareConversations);
	renderChats();
}

function memoryRows() {
	const records = [];
	let incomplete = false;
	for (const file of data) {
		for (const line of file.records.split("\n").filter(Boolean)) {
			try {
				const record = JSON.parse(line);
				if (typeof record.text !== "string") continue;
				records.push({ ...record, namespace: record.namespace || file.namespace });
			} catch {
				incomplete = true;
			}
		}
	}
	const superseded = new Set(records.flatMap((record) => [record.supersedes || []].flat()));
	for (const record of records)
		record.effectiveStatus = superseded.has(record.id) ? "superseded" : record.status || "unknown";
	if (incomplete)
		showNotice("Memory snapshot is incomplete; some records or correction links may be missing.");
	return records.sort((left, right) =>
		String(right.created_at || "").localeCompare(String(left.created_at || "")),
	);
}

function renderMemory() {
	const paged = !Array.isArray(data);
	if (paged) memoryQuery = { ...data.query, page: data.page };
	toolbar.replaceChildren();
	setupToolbar();
	const records = paged ? data.records : memoryRows();
	const filtered = paged
		? records
		: records.filter(
				(record) =>
					(!memoryQuery.namespace || record.namespace === memoryQuery.namespace) &&
					(!memoryQuery.kind || record.kind === memoryQuery.kind) &&
					(!memoryQuery.status || record.effectiveStatus === memoryQuery.status) &&
					JSON.stringify(record).toLowerCase().includes(memoryQuery.q.toLowerCase()),
			);
	const pages = paged ? data.pages : Math.max(1, Math.ceil(filtered.length / 20));
	memoryQuery.page = Math.min(memoryQuery.page, pages);
	if (paged && data.invalidRecords)
		showNotice(`Skipped ${data.invalidRecords} invalid memory records. Source files were not modified.`);
	view.replaceChildren(
		element(
			"p",
			`${paged ? data.total : filtered.length} matching / ${paged ? data.recordCount : records.length} records · read-only`,
			"counts",
		),
	);
	if (!filtered.length) view.append(element("p", "No matching memory records.", "empty"));
	for (const record of paged
		? filtered
		: filtered.slice((memoryQuery.page - 1) * 20, memoryQuery.page * 20)) {
		const card = element("article", undefined, "memory-record");
		const header = element("header", undefined, "row-head");
		header.append(element("span", `${record.namespace} / ${record.kind || "unknown"}`));
		header.append(
			element("span", `${record.effectiveStatus} · ${record.event_time || record.created_at || ""}`, "meta"),
		);
		card.append(header, element("p", record.text, "memory-text"));
		if (Array.isArray(record.subjects) && record.subjects.length)
			card.append(element("p", record.subjects.join(" / "), "muted"));
		const details = element("details", undefined, "record-details");
		details.id = `record-${record.id}`;
		const summary = element("summary", "...", "record-details-icon");
		summary.setAttribute("aria-label", "Record details");
		summary.title = "Details";
		details.append(summary);
		details.append(element("pre", JSON.stringify(record, null, 2)));
		card.append(details);
		view.append(card);
	}
	const pagination = element("nav", undefined, "pagination");
	pagination.setAttribute("aria-label", "Memory pagination");
	for (const [label, delta] of [
		["< Previous", -1],
		["Next >", 1],
	]) {
		const button = element("button", label);
		button.type = "button";
		button.disabled = memoryQuery.page + delta < 1 || memoryQuery.page + delta > pages;
		button.addEventListener("click", () => {
			memoryQuery.page += delta;
			if (paged) void refresh();
			else renderMemory();
			main.scrollTop = 0;
		});
		pagination.append(button);
		if (delta === -1) pagination.append(element("span", `Page ${memoryQuery.page} / ${pages}`));
	}
	view.append(pagination);
}

function renderSettings() {
	view.replaceChildren(
		element(
			"p",
			"Read-only runtime configuration. Edit settings.json and use /reload to apply changes.",
			"muted",
		),
	);
	for (const [title, rows] of [
		[
			"Chat replies",
			[
				["Allowlist", data.chatAllowlist.whitelist],
				["Blocklist", data.chatAllowlist.blacklist],
			],
		],
		[
			"Rich text",
			[
				["Enabled", data.richText.enabled],
				["Markdown", data.richText.markdown],
			],
		],
	]) {
		const card = element("section", undefined, "card");
		card.append(element("header", title, "card-header"));
		const table = element("table", undefined, "setting-table");
		for (const [name, value] of rows) {
			const row = table.insertRow();
			row.append(element("th", name));
			const cell = row.insertCell();
			if (Array.isArray(value)) {
				const list = element("ul");
				for (const item of value) list.append(element("li", item));
				cell.append(value.length ? list : element("span", "None", "muted"));
			} else cell.textContent = value ? "on" : "off";
		}
		card.append(table);
		view.append(card);
	}
}

function renderLogs() {
	const scrollPositions = Array.from(view.querySelectorAll(".card-content"), (node) => ({
		top: node.scrollTop,
		bottom: node.scrollHeight - node.scrollTop - node.clientHeight < 20,
	}));
	view.replaceChildren();
	const host = element("section", undefined, "card");
	host.append(element("header", "service.log", "card-header"));
	const hostBody = element("div", undefined, "card-content");
	hostBody.append(
		element("pre", data.hostLog || "No service.log yet. Foreground output remains in the startup Terminal."),
	);
	host.append(hostBody);
	view.append(host);
	const tasks = element("section", undefined, "card");
	tasks.append(element("header", "Native execution history", "card-header"));
	const taskBody = element("div", undefined, "card-content");
	const table = element("table", undefined, "task-table");
	const heading = table.insertRow();
	for (const label of ["ID", "Type", "State", "Details"]) heading.append(element("th", label));
	for (const task of data.tasks?.items || []) {
		const row = table.insertRow();
		for (const value of [task.id, task.kind || task.type || "task", task.state?.status || task.status || "—"])
			row.append(element("td", value));
		const detail = element("details");
		detail.id = `task-${task.id}`;
		detail.append(element("summary", "Details"), element("pre", JSON.stringify(task, null, 2)));
		row.insertCell().append(detail);
	}
	taskBody.append(table);
	if (!data.tasks?.items?.length) taskBody.append(element("p", "No task records.", "empty"));
	if (data.tasks?.next) {
		const next = new URL(location.href);
		next.searchParams.set(
			"cursor",
			btoa(JSON.stringify(data.tasks.next)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
		);
		taskBody.append(link("Older tasks >", next.pathname + next.search, "pagination"));
	}
	tasks.append(taskBody);
	view.append(tasks);
	[hostBody, taskBody].forEach((node, index) => {
		const previous = scrollPositions[index];
		node.scrollTop = !previous || previous.bottom ? node.scrollHeight : previous.top;
	});
}

function renderScheduled() {
	document.querySelector(".native-state")?.remove();
	view.replaceChildren();
	function time(timestamp, timezone) {
		return typeof timestamp === "number"
			? new Date(timestamp).toLocaleString("sv-SE", { timeZone: timezone })
			: "-";
	}
	function history(runs, conversationId, timezone) {
		const body = element("div", undefined, "card-content");
		const table = element("table", undefined, "task-table");
		const heading = table.insertRow();
		for (const label of ["Task", "Due", "Started", "Finished", "State / delivery", "Result"])
			heading.append(element("th", label));
		for (const run of runs) {
			const row = table.insertRow();
			row
				.insertCell()
				.append(
					link(
						`${run.name || "Execution"} #${run.id}`,
						`/tasks?conversationId=${conversationId}#tree-task-${run.id}`,
					),
				);
			for (const value of [
				time(run.input?.dueAt, timezone),
				time(run.input?.startedAt, timezone),
				time(run.result?.finishedAt, timezone),
				[run.status, run.delivery].filter(Boolean).join(" / "),
				run.error || run.result?.summary || "In progress",
			])
				row.append(element("td", value));
		}
		body.append(table);
		if (!runs.length) body.append(element("p", "No executions yet.", "empty"));
		return body;
	}
	for (const job of data.jobs || []) {
		const details = element("details", undefined, "schedule-row");
		details.id = `schedule-history-${job.id}`;
		const latest = job.runs?.[0];
		const status = !job.enabled
			? "disabled"
			: ["aborted", "faulted", "failed", "missing"].includes(job.status)
				? job.status
				: latest
					? [latest.status, latest.delivery].filter(Boolean).join(" / ")
					: "enabled";
		const lastRun = latest ? time(latest.input?.startedAt, job.timezone) : "No executions yet";
		const cadence = job.time !== undefined ? `daily ${job.time}` : `every ${job.intervalMs / 3600000}h`;
		const summary = element("summary", undefined, "schedule-summary");
		summary.append(
			element("span", job.name, "schedule-name"),
			element(
				"span",
				`${cadence} / Next: ${time(job.nextAt, job.timezone)} (${job.timezone})`,
				"schedule-next",
			),
			element("span", `Last: ${lastRun}`, "schedule-last"),
			element("span", status, "schedule-status"),
		);
		details.append(summary, history(job.runs || [], job.conversationId, job.timezone));
		view.append(details);
	}
	if (!data.jobs?.length) view.append(element("p", "No scheduled tasks.", "empty"));
}

function renderTasks() {
	view.replaceChildren();
	const children = new Map();
	const conversations = new Map(data.conversations.map((conversation) => [conversation.id, conversation]));
	const chatNames = new Map(
		(data.chats?.items || []).map((chat) => [
			chat.conversationId,
			chatName({ ...chat, history: { groupName: conversations.get(chat.conversationId)?.groupName } }, []),
		]),
	);
	const conversationNames = new Map(chatNames);
	const scheduleNames = new Map((data.schedules?.items || []).map((job) => [job.conversationId, job.name]));
	for (const [id, name] of scheduleNames) conversationNames.set(id, name);
	for (const session of data.sessions?.items || []) {
		if (!conversationNames.has(session.conversationId))
			conversationNames.set(session.conversationId, session.label);
	}
	function conversationName(id) {
		const name = conversationNames.get(id);
		if (name) return name;
		const owner = conversations.get(id)?.owner;
		if (!owner) return "";
		const parentName = conversationName(owner.conversationId);
		return parentName ? `${parentName} / subagent` : "subagent";
	}
	function belongsToChat(id) {
		if (chatNames.has(id) || scheduleNames.has(id)) return true;
		const owner = conversations.get(id)?.owner;
		return owner ? belongsToChat(owner.conversationId) : false;
	}
	for (const conversation of data.conversations.toSorted(compareConversations)) {
		const key = conversation.owner ? `task-${conversation.owner.taskId}` : "root";
		if (!children.has(key)) children.set(key, []);
		children.get(key).push({ type: "conversation", ...conversation });
	}
	for (const task of data.tasks) {
		const key = task.owner === undefined ? `conversation-${task.conversationId}` : `task-${task.owner}`;
		if (!children.has(key)) children.set(key, []);
		children.get(key).push({ type: "task", ...task });
	}
	function renderNode(node) {
		const item = element("li");
		const key = `${node.type}-${node.id}`;
		item.id = `tree-${key}`;
		if (node.type === "conversation") {
			const heading = element("span", `Conversation #${node.id}`);
			const name = conversationName(node.id);
			if (name) heading.append(element("span", ` / ${name}  `, "meta"));
			if (chatNames.has(node.id)) {
				heading.append(link("Chat", `/chat?conversationId=${node.id}`, "meta"));
			}
			item.append(heading);
		} else {
			const detail = element("details");
			detail.id = key;
			const summary = element("summary", `${node.kind}${node.name ? `: ${node.name}` : ""} #${node.id}`);
			const status = [node.status, node.phase, node.outcome].filter(Boolean).join(" / ");
			const waiting = node.on?.length ? ` on [${node.on.join(", ")}]` : "";
			const flags = `${node.background ? " [background]" : ""}${node.abortRequested ? " [abort requested]" : ""}`;
			summary.append(element("span", `  ${status}${waiting}${flags}`, "meta"));
			const content = element("pre", "Loading latest state...");
			detail.append(summary, content);
			let loaded = false;
			detail.addEventListener("toggle", async () => {
				if (!detail.open || loaded) return;
				loaded = true;
				try {
					const task = await fetchData(`/tasks/task/data?taskId=${node.id}`);
					content.textContent = JSON.stringify(task, null, 2);
				} catch (error) {
					loaded = false;
					content.textContent = error.message;
				}
			});
			item.append(detail);
		}
		const descendants = children.get(key) || [];
		if (descendants.length) {
			const list = element("ul", undefined, "task-tree");
			for (const child of descendants) list.append(renderNode(child));
			item.append(list);
		}
		return item;
	}
	const roots = conversationId
		? data.conversations
				.filter((conversation) => String(conversation.id) === conversationId)
				.map((conversation) => ({ type: "conversation", ...conversation }))
		: children.get("root") || [];
	const visible = roots.filter((conversation) => belongsToChat(conversation.id));
	if (!visible.length) view.append(element("p", "No conversations.", "empty"));
	for (const conversation of visible.toSorted(compareConversations)) {
		const card = element("section", undefined, "card");
		card.id = `tasks-${conversation.id}`;
		const list = element("ul", undefined, "task-tree task-root");
		list.append(renderNode(conversation));
		card.append(list);
		view.append(card);
	}
}

function setupToolbar() {
	if (page === "/chat" || page === "/tasks") {
		if (conversationId) {
			toolbar.className = "toolbar";
			toolbar.append(page === "/chat" ? link("< Recent Chats", "/") : link("< All conversations", "/tasks"));
		}
	} else if (page === "/memory") {
		const records = Array.isArray(data) ? memoryRows() : data.records;
		const form = element("form", undefined, "toolbar");
		const searchLabel = element("label", "Search text / subjects / sources", "search");
		const search = element("input");
		search.type = "search";
		search.name = "q";
		search.value = memoryQuery.q;
		search.placeholder = "Keyword, record ID or source";
		searchLabel.append(search);
		form.append(searchLabel);
		for (const [name, label, values] of [
			[
				"namespace",
				"Namespace",
				data.namespaces || [...new Set(records.map((record) => record.namespace))].sort(),
			],
			[
				"kind",
				"Kind",
				data.kinds || [...new Set(records.map((record) => record.kind).filter(Boolean))].sort(),
			],
			["status", "Status", ["active", "superseded", "deleted", "unknown"]],
		]) {
			const field = element("label", label);
			const select = element("select");
			select.name = name;
			select.append(new Option("All", ""));
			for (const value of values) select.append(new Option(value, value));
			if (memoryQuery[name] && !values.includes(memoryQuery[name]))
				select.append(new Option(memoryQuery[name], memoryQuery[name]));
			select.value = memoryQuery[name];
			field.append(select);
			form.append(field);
		}
		const button = element("button", "Filter");
		button.type = "submit";
		form.append(button);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			memoryQuery = { ...memoryQuery, ...Object.fromEntries(new FormData(form)), page: 1 };
			void refresh();
			main.scrollTop = 0;
		});
		toolbar.append(form);
	}
}

async function render() {
	const openDetails = new Set(Array.from(view.querySelectorAll("details[open]"), (node) => node.id));
	const scrollTop = main.scrollTop;
	const windowPositions = new Map(
		Array.from(view.querySelectorAll(".card"), (card) => [card.id, card.scrollTop]),
	);
	if (page === "/chat") await loadChats();
	else if (page === "/memory") renderMemory();
	else if (page === "/settings") renderSettings();
	else if (page === "/logs") renderLogs();
	else if (page === "/tasks") renderTasks();
	else if (page === "/scheduled") renderScheduled();
	for (const node of view.querySelectorAll("details")) node.open = openDetails.has(node.id);
	for (const card of view.querySelectorAll(".card")) card.scrollTop = windowPositions.get(card.id) || 0;
	main.scrollTop = scrollTop;
	view.setAttribute("aria-busy", "false");
}

async function refresh() {
	if (refreshing) return;
	refreshing = true;
	document.getElementById("refresh").disabled = true;
	try {
		const query = new URLSearchParams(location.search);
		if (page === "/chat") query.set("view", conversationId ? "display" : "overview");
		if (page === "/memory") {
			query.set("view", "records");
			for (const [key, value] of Object.entries(memoryQuery)) query.set(key, String(value));
		}
		data = await fetchData(`${page}/data?${query}`);
		state.textContent = JSON.stringify(data, null, 2);
		showNotice("");
		await render();
	} catch (error) {
		showNotice(error.message);
	} finally {
		refreshing = false;
		document.getElementById("refresh").disabled = false;
		view.setAttribute("aria-busy", "false");
	}
}

if (page !== "/memory") setupToolbar();
refreshing = true;
render()
	.catch((error) => {
		showNotice(error.message);
		view.setAttribute("aria-busy", "false");
	})
	.finally(() => {
		refreshing = false;
	});
document.getElementById("refresh").addEventListener("click", refresh);
