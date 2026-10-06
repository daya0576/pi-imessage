function escapeHtml(text: string) {
	return text.replace(
		/[&<>"']/g,
		(value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value] ?? value,
	);
}

/** The legacy shell, backed by native read-only APIs rather than legacy host state. */
export function renderPage(page: string, state: string) {
	const active = page === "/" || page === "/chat" ? "/" : page;
	const navigation = [
		["/", "Recent Chats"],
		["/tasks", "Tasks"],
		["/scheduled", "Scheduled"],
		["/logs", "Logs"],
		["/memory", "Memory"],
		["/settings", "Settings"],
	]
		.map(
			([href, label]) =>
				`<a href="${href}"${href === active ? ' class="active" aria-current="page"' : ""}>${label}</a>`,
		)
		.join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>blue — pi-imessage</title><link rel="stylesheet" href="/assets/style.css">
<script src="/assets/app.js" defer></script></head>
<body><nav class="app-nav" aria-label="Main navigation">${navigation}</nav>
<main class="content" id="main"><header class="page-header"><h1 id="title">Recent Chats</h1>
<div class="connection"><button id="refresh" type="button">Refresh</button></div></header>
<div id="toolbar"></div><p id="notice" role="status" hidden></p><div id="view" aria-busy="true"></div>
<details class="native-state"><summary>Native state</summary><pre id="state">${escapeHtml(state)}</pre></details></main>
<aside class="chat-list" id="chat-list" aria-label="Conversations" hidden></aside>
</body></html>`;
}
