// Reproducible snapshots only: edit the authoritative dotfile extension, then sync.
// Usage: node src/shared-scheduler/sync.mjs [--check] /path/to/extensions/scheduler
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const destination = dirname(fileURLToPath(import.meta.url));
const check = process.argv[2] === "--check";
const sourceArgument = process.argv[check ? 3 : 2];
if (!sourceArgument) throw new Error("Provide the authoritative dotfile scheduler directory");
const source = resolve(sourceArgument);
const files = ["index.ts", "service.cjs", "time.cjs", "service.d.cts", "time.d.cts"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (path) => digest(readFileSync(path));
const sourceDirectory = "pi-config/agent/extensions/scheduler";
const committedHash = (revision, file) =>
	digest(execFileSync("git", ["-C", source, "show", `${revision}:${sourceDirectory}/${file}`]));
if (check) {
	const provenance = JSON.parse(readFileSync(join(destination, "provenance.json"), "utf8"));
	for (const file of files) {
		if (
			!provenance.sourceCommit ||
			committedHash(provenance.sourceCommit, file) !== provenance.files[file] ||
			hash(join(source, file)) !== provenance.files[file] ||
			hash(join(destination, file)) !== provenance.files[file]
		) {
			throw new Error(`Shared scheduler drift: ${file}; sync from the authoritative extension`);
		}
	}
	console.log("Shared scheduler snapshot matches authoritative source and SHA256 provenance");
} else {
	const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	for (const file of files) {
		if (hash(join(source, file)) !== committedHash(sourceCommit, file)) {
			throw new Error(`Commit authoritative scheduler changes before syncing: ${file}`);
		}
	}
	const hashes = {};
	for (const file of files) {
		copyFileSync(join(source, file), join(destination, file));
		hashes[file] = hash(join(destination, file));
	}
	writeFileSync(
		join(destination, "provenance.json"),
		`${JSON.stringify(
			{
				version: 1,
				apiVersion: 1,
				sourceRepository: "https://github.com/daya0576/dotfile",
				sourceDirectory,
				sourceCommit,
				algorithm: "sha256",
				files: hashes,
			},
			null,
			"\t"
		)}\n`
	);
	console.log("Synced exact scheduler source snapshot with SHA256 provenance");
}
