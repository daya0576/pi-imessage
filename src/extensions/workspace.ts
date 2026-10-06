import { readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import { ScheduledOutbox, validateSchedules, type WorkspaceExtension } from "./schedules.ts";

const loadModule = createRequire(import.meta.url);

/** Personal modules receive the host's pinned SDK and their own configuration. */
export type WorkspaceExtensionContext = {
	workingDir: string;
	config: Record<string, unknown>;
	Type: typeof Type;
	defineExtension: typeof defineExtension;
	defineTool: typeof defineTool;
	defineDoc: typeof defineDoc;
	defineTask: typeof defineTask;
	configure: typeof configure;
	ScheduledOutbox: typeof ScheduledOutbox;
	section: typeof section;
};

/** A chat assistant can apply its own workspace changes through the existing host owner. */
export function workspaceExtension(reload: () => Promise<unknown>) {
	return defineExtension({
		name: "workspace-loader",
		tools: [
			defineTool({
				name: "reload_extensions",
				description:
					"Reload trusted workspace extensions and configuration without interrupting current calls or resetting deadlines. Invalid changes keep the previous definitions.",
				parameters: Type.Object({}),
				replay: "unsafe",
				async execute() {
					await reload();
					return { content: [{ type: "text", text: "Workspace extensions and configuration reloaded." }] };
				},
			}),
		],
	});
}

/** Scan only direct workspace extension directories; never skills or attachments (ADR 0035). */
export async function loadWorkspaceExtensions(workingDir: string) {
	const extensions: WorkspaceExtension[] = [];
	const root = join(workingDir, "extensions");
	const directories = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const taskNames = new Set<string>();
	for (const directory of directories.sort((first, second) => first.name.localeCompare(second.name))) {
		if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
		const moduleDirectory = await realpath(join(root, directory.name));
		const filename = await realpath(join(moduleDirectory, "index.ts"));
		if (!filename.startsWith(`${moduleDirectory}${sep}`))
			throw new Error("Workspace extension entry must remain inside its own directory");
		const config: unknown = JSON.parse(
			await readFile(join(moduleDirectory, "config.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "{}";
				throw error;
			}),
		);
		if (!config || typeof config !== "object" || Array.isArray(config))
			throw new Error("Workspace extension config must be an object");
		const source = await readFile(filename, "utf8");
		if (/^\s*(?:export\s+(?!type\b)|import\s+(?!type\b))/m.test(source))
			throw new Error("Workspace code must use CommonJS factories (module.exports and require) for reload");
		// CommonJS entry/dependency eviction reloads code without invalidating existing call references.
		for (const cached of Object.keys(loadModule.cache)) {
			if (cached.startsWith(`${moduleDirectory}${sep}`)) delete loadModule.cache[cached];
		}
		const loaded: unknown = loadModule(filename);
		const factory = loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded;
		if (typeof factory !== "function") throw new Error("Workspace extension must export a factory");
		const extension: unknown = await factory({
			workingDir,
			config: config as Record<string, unknown>,
			Type,
			defineExtension,
			defineTool,
			defineDoc,
			defineTask,
			configure,
			ScheduledOutbox,
			section,
		} satisfies WorkspaceExtensionContext);
		if (
			!extension ||
			typeof extension !== "object" ||
			!("name" in extension) ||
			typeof extension.name !== "string" ||
			!extension.name.trim()
		)
			throw new Error("Workspace factory must return a named Durable extension");
		if (extensions.some((installed) => installed.name === extension.name))
			throw new Error("Duplicate workspace extension name");
		const native = extension as WorkspaceExtension;
		for (const task of native.tasks ?? []) {
			if (taskNames.has(task.definition.name)) throw new Error("Duplicate workspace task name");
			taskNames.add(task.definition.name);
		}
		extensions.push(native);
	}
	validateSchedules(extensions);
	return extensions;
}
