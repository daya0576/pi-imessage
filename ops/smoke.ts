// Operator-only live smoke: never called by tests or the agent.
// It makes one paid model health request; the operator sends one real message.
// HTTP /prompt is retired (ADR 0018), so the full path is chat.db -> agent -> Messages.app.
type Receipts = { answers?: Record<string, string> };

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const chatGuid = option("--chat");
if (!args.includes("--live") || !chatGuid) {
	console.log(
		"Operator only: node --experimental-strip-types ops/smoke.ts --live --chat CHAT_GUID [--url http://localhost:7750] [--timeout 300]",
	);
} else {
	const base = option("--url") ?? "http://localhost:7750";
	const timeoutMs = Number(option("--timeout") ?? 300) * 1000;
	const read = async <T>(path: string) => {
		const response = await fetch(`${base}${path}`);
		if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
		return (await response.json()) as T;
	};

	console.log("Model health:", await read("/health/model"));
	const state = await read<{ chats?: { items: { chatGuid: string; conversationId: number }[] } }>("/chat/data");
	const chat = state.chats?.items.find((item) => item.chatGuid === chatGuid);
	if (!chat) throw new Error("Chat has no conversation yet; send it one message first");
	const receipts = async () =>
		(await read<{ delivery?: Receipts }>(`/chat/data?conversationId=${chat.conversationId}&view=display`)).delivery
			?.answers ?? {};
	const before = new Set(Object.keys(await receipts()));

	console.log("Now send this from the device to the chat: Reply with: smoke received.");
	const deadline = Date.now() + timeoutMs;
	let receipt: [string, string] | undefined;
	while (!receipt && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		receipt = Object.entries(await receipts()).find(([entryId, status]) => !before.has(entryId) && status !== "sending");
	}
	if (!receipt) throw new Error("No new reply receipt before the timeout");
	console.log(`Reply entry ${receipt[0]}: ${receipt[1]}`);
	if (receipt[1] !== "sent") throw new Error("Reply was not confirmed sent; do not resend it");
	console.log("Confirm exactly one reply on the device.");
}
