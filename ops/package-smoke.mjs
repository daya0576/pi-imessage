import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(".");
const directory = await mkdtemp(join(tmpdir(), "imessage-package-"));
try {
  let specification = process.argv[2];
  if (!specification) {
    const packed = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root });
    const [manifest] = JSON.parse(packed.stdout);
    assert.equal(manifest.name, "@kingcrab/pi-imessage");
    for (const file of manifest.files) {
      assert.ok(/^(dist\/|docs\/|examples\/|ops\/(README\.md|preflight\.mjs)$|package\.json$|README\.md$|LICENSE$)/.test(file.path), `Unexpected package file: ${file.path}`);
      assert.ok(!/(^|\/)(?:\.env(?:\.|$)|\.npmrc$|auth\.json$|settings\.json$|node_modules\/|test\/)/.test(file.path), `Private or development file: ${file.path}`);
    }
    specification = join(directory, manifest.filename);
  }
  await execute("npm", ["install", "--global", "--prefix", directory, "--ignore-scripts", "--no-audit", "--no-fund", specification], { timeout: 120000, maxBuffer: 1024 * 1024 });
  const installed = join(directory, "lib", "node_modules", "@kingcrab", "pi-imessage");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(metadata.version, JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
  assert.equal(metadata.bin["pi-imessage"], "dist/cli.js");
  assert.notEqual(metadata.private, true);
  for (const asset of ["app.js", "style.css"]) {
    assert.deepEqual(await readFile(join(installed, "dist", "web", asset)), await readFile(join(root, "src", "web", asset)));
  }
  const environment = {
    HOME: directory,
    PATH: process.env.PATH,
    WORKING_DIR: join(directory, "workspace"),
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    DOTENV_CONFIG_PATH: join(directory, "missing.env"),
  };
  const binary = join(directory, "bin", "pi-imessage");
  const help = await execute(binary, ["--help"], { cwd: directory, env: environment, timeout: 10000 });
  assert.ok(help.stdout.includes("pi-imessage [serve]"), "Installed symlink did not execute CLI help");
  const install = await execute(binary, ["install"], { cwd: directory, env: environment, timeout: 10000 });
  assert.ok(install.stdout.includes("Not loaded."));
  const plist = await readFile(join(directory, "Library", "LaunchAgents", "org.pi-imessage.service.plist"), "utf8");
  assert.ok(plist.includes(join(installed, "dist", "cli.js")));
  assert.ok(!plist.includes("src/cli.ts"));
  console.log(`Package smoke passed: ${metadata.name}@${metadata.version}, installed CLI symlink, inert launchd generation and Web assets. No models, Messages or production workspace were accessed.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
