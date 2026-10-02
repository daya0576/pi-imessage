import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface ResetAgent {
	newSession(chatGuid: string): Promise<void>;
	getRuntimeStatus(): { sessionSettings: { chatGuid: string; sessionKey: string }[] };
}
export interface ResetReceipt {
	runId: string;
	status: "running" | "completed" | "failed";
	targets: string[];
	completed: string[];
	failed: string[];
}
const CHAT_GUID = /^(?:iMessage|SMS|RCS);[+-];[a-zA-Z0-9_+@.\-]+$/;
const RUN_ID = /^nightly-reset-\d{4}-\d{2}-\d{2}$/;

/** A receipt is claimed BEFORE cancelling anything. Uncertain attempts are never replayed. */
export function createNightlyReset(workingDir: string, agent: ResetAgent) {
	const directory = join(workingDir, ".nightly-reset");
	let busy = false;
	function receiptPath(runId: string): string {
		if (!RUN_ID.test(runId)) throw new Error("Invalid nightly reset run ID");
		return join(directory, `${runId}.json`);
	}
	function inspect(runId: string): ResetReceipt | undefined {
		const path = receiptPath(runId);
		return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ResetReceipt) : undefined;
	}
	function syncDirectory(path: string): void {
		const descriptor = openSync(path, "r");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	}
	function persist(receipt: ResetReceipt): void {
		const path = receiptPath(receipt.runId);
		writeFileSync(`${path}.tmp`, JSON.stringify(receipt), { mode: 0o600, flush: true });
		renameSync(`${path}.tmp`, path);
		syncDirectory(directory);
	}
	async function reset(runId: string): Promise<ResetReceipt> {
		receiptPath(runId);
		const existing = inspect(runId);
		if (existing) return existing;
		if (busy) throw new Error("Another nightly reset is active");
		if (existsSync(directory)) {
			for (const file of readdirSync(directory)) {
				if (file.endsWith(".json") && inspect(file.slice(0, -5))?.status === "running")
					throw new Error("Prior nightly reset is unresolved; inspect before new reset");
			}
		}
		const targets = new Set<string>();
		for (const entry of readdirSync(workingDir, { withFileTypes: true })) {
			if (entry.isDirectory() && CHAT_GUID.test(entry.name)) targets.add(entry.name);
		}
		for (const entry of agent.getRuntimeStatus().sessionSettings) {
			if (entry.sessionKey === entry.chatGuid && CHAT_GUID.test(entry.chatGuid)) targets.add(entry.chatGuid);
		}
		// Never follow chat/context symlinks into unrelated files, even for an active session.
		for (const chatGuid of targets) {
			for (const path of [join(workingDir, chatGuid), join(workingDir, chatGuid, "context.jsonl")]) {
				try {
					if (lstatSync(path).isSymbolicLink()) throw new Error("Refusing symlink in reset target");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		}
		const receipt: ResetReceipt = { runId, status: "running", targets: [...targets].sort(), completed: [], failed: [] };
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(receiptPath(runId), JSON.stringify(receipt), { flag: "wx", mode: 0o600, flush: true });
		syncDirectory(directory);
		syncDirectory(workingDir);
		busy = true;
		console.log(`[nightly-reset] started ${runId}: ${receipt.targets.length} ordinary chats; active chats included`);
		try {
			// Fence every target immediately; each /new waits for its actual SDK operation to settle.
			const results = await Promise.allSettled(
				receipt.targets.map(async (chatGuid) => {
					try {
						await agent.newSession(chatGuid);
						receipt.completed.push(chatGuid);
					} catch {
						receipt.failed.push(chatGuid);
					}
					persist(receipt);
				})
			);
			if (results.some((result) => result.status === "rejected"))
				throw new Error("Reset receipt persistence failed; inspect before retry");
			receipt.status = receipt.failed.length ? "failed" : "completed";
			persist(receipt);
			console.log(
				`[nightly-reset] ${receipt.status} ${runId}: reset=${receipt.completed.length} failed=${receipt.failed.length}; no service restart`
			);
			return receipt;
		} finally {
			busy = false;
		}
	}
	return { reset, inspect };
}

/** No browser-origin calls or LAN access to the destructive maintenance endpoint. */
export function allowsNightlyReset(
	remoteAddress: string | undefined,
	origin: string | undefined,
	header: unknown
): boolean {
	return (
		["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress ?? "") && !origin && header === "nightly-reflection"
	);
}
