import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

const run = promisify(execFile);

/** The store's own CLI finds its data next to itself; we only pass arguments. */
async function memoryCli(workingDir: string, args: string[], signal?: AbortSignal) {
	const cli = join(workingDir, "skills", "file-memory", "memory_cli.py");
	const { stdout } = await run("python3", [cli, ...args], {
		timeout: 30000,
		maxBuffer: 16 * 1024 * 1024,
		signal,
	});
	return stdout;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** Structured memory tools; the namespace list and core memory are read when the extension is built. */
export async function memoryExtension(workingDir: string) {
	const namespaces = await memoryCli(workingDir, ["list-namespaces"])
		.then((output) =>
			(JSON.parse(output) as { namespace: string; active: number }[]).map((item) => item.namespace),
		)
		.catch((error) => {
			console.warn("Memory store unavailable", error);
			return undefined;
		});
	const core = await readFile(join(workingDir, "skills", "file-memory", "core.md"), "utf8").catch(() => "");
	const instructions = `Structured memory is the only active read/write memory. Legacy MEMORY.md files are read-only archives.

Read:
- Use load_memory when prior context may help; choose relevant namespaces from meaning, not fixed keywords.
- Available namespaces: ${namespaces === undefined ? "(memory store unavailable)" : namespaces.join(", ") || "(none yet)"}
- Use search_memory to find a specific record, especially before a correction.
- Treat memory as context, not as a substitute for the current message or verified facts.

Write:
- When you learn something important and durable, call save_memory with concise atomic text, namespace, kind, subjects, factual event date when known, and a specific source.
- Do not store every message, guesses, short-lived states, secrets or duplicates.
- For corrections, find the old ID and set supersedes_id. Never silently overwrite history or edit the JSONL files directly.

Core memory:
${core.trim() || "(no core memory yet)"}`;
	return defineExtension({
		name: "memory",
		sections: [section("memory", () => instructions)],
		tools: [
			defineTool({
				name: "search_memory",
				description: "Search active structured memories.",
				parameters: Type.Object({
					query: Type.String(),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
					namespaces: Type.Optional(Type.Array(Type.String())),
				}),
				replay: "safe",
				async execute(args, _api, context) {
					const filters = (args.namespaces ?? []).map((namespace) => `--namespace=${namespace}`);
					return text(
						await memoryCli(
							workingDir,
							["search", "--limit", String(args.limit ?? 10), ...filters, "--", args.query],
							context.abortSignal,
						),
					);
				},
			}),
			defineTool({
				name: "load_memory",
				description: "Load every active record of the given namespaces.",
				parameters: Type.Object({ namespaces: Type.Array(Type.String(), { minItems: 1 }) }),
				replay: "safe",
				async execute(args, _api, context) {
					return text(
						await memoryCli(
							workingDir,
							["load", ...args.namespaces.map((namespace) => `--namespace=${namespace}`)],
							context.abortSignal,
						),
					);
				},
			}),
			defineTool({
				name: "save_memory",
				description: "Append an important atomic fact. Use supersedes_id to correct an older fact.",
				parameters: Type.Object({
					text: Type.String(),
					namespace: Type.String(),
					kind: Type.Union([
						Type.Literal("fact"),
						Type.Literal("event"),
						Type.Literal("preference"),
						Type.Literal("procedure"),
					]),
					subjects: Type.Array(Type.String()),
					event_time: Type.Union([Type.String(), Type.Null()]),
					source: Type.String(),
					importance: Type.Number({ minimum: 0, maximum: 1 }),
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
					supersedes_id: Type.Optional(Type.String()),
				}),
				// The store skips an identical record, so a rerun after a crash does not duplicate it.
				replay: "safe",
				async execute(args, _api, context) {
					return text(
						await memoryCli(
							workingDir,
							[
								"add",
								`--text=${args.text}`,
								`--namespace=${args.namespace}`,
								`--kind=${args.kind}`,
								"--subjects",
								...args.subjects,
								...(args.event_time ? [`--event-time=${args.event_time}`] : []),
								`--source=${args.source}`,
								`--importance=${args.importance}`,
								`--confidence=${args.confidence}`,
								...(args.supersedes_id ? [`--supersedes=${args.supersedes_id}`] : []),
							],
							context.abortSignal,
						),
					);
				},
			}),
		],
	});
}
