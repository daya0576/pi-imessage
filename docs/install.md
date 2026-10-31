# Installation

## Prerequisites

- macOS, Node >=22.22.2, Python 3 and authenticated Pi models.
- Terminal/Node Full Disk Access for Messages' SQLite database; Automation and
  Accessibility permissions for Messages.app/rich-text sends; `/usr/bin/sips`.
- The existing memory CLI at `WORKING_DIR/skills/file-memory/memory_cli.py`.
- The installed `pi-browser` CLI and its pinned Playwright runtime. Run
  `pi-browser setup` when needed and authorized; `pi-imessage preflight` never
  installs it. Preflight
  resolves the wrapper in Pi's agent `bin/`, or a preflight-only
  `PI_BROWSER_CLI_PATH` override, and runs `--version` with temporary browser state
  that is removed afterward. A wrapper whose `doctor` reports MISSING is not ready.
  Version readiness does not prove browser privacy, login or per-chat isolation.
- Reviewed native SQLite and image dependencies. Install dependencies with
  `npm ci --ignore-scripts`; if native binaries are missing, review and approve
  their build/download separately rather than silently enabling install scripts.

Safe local checks (no live models/messages/workspace):

```sh
npm run check
npm test
node --experimental-strip-types src/cli.ts preflight
node --experimental-strip-types src/cli.ts --help
```

For changes to the built-in browser, also run
`node --experimental-strip-types scripts/browser-smoke.mjs`. This uses real headless
Chrome and the installed pinned CLI with temporary HOME/profiles, loopback pages
and synthetic login state; it never opens a personal profile or sends a message.
See [browser isolation and retention](browser.md).

`WORKING_DIR`, `WEB_HOST`, `WEB_PORT`, `WEB_ENABLED` and `MESSAGES_DB_PATH`
are explicit host configuration. `npm start`, the
executable CLI and the generated launchd job enable Node's environment proxy
support. `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and their lowercase forms) and
`NODE_OPTIONS` are retained when generating the job; review them before install.
CLI execution loads the current directory's `.env` using Node's parser; existing
environment values take precedence and a missing file is allowed. Set
`DOTENV_CONFIG_PATH` for another file. Module imports and `--help` do not load it.
Other read errors stop startup without printing file contents. `.env` is trusted
operator configuration, not a message attachment. Keep it private and out of Git.
Installation pins its current directory as the job's working directory, so the
same configuration path is used at launch. Selected environment values in the
plist are a snapshot; regenerate a reviewed job to change those overrides.
The job also pins the selected Pi agent directory as an absolute
`PI_CODING_AGENT_DIR` (including the default). Relative paths and `~` are resolved
at installation, after `.env` loading, so daemon HOME/cwd changes do not select a
different auth.json, models.json, settings.json or skill root. This selects a
configuration location; it does not copy credentials or grant access to it.

No proxy credentials are printed by installation. Application startup configures
one process-owned Undici transport after `.env` loading and before model/auth
refresh. Global Pi `httpProxy` supplies HTTP/HTTPS defaults; explicit environment
values win, lowercase proxy/bypass values take precedence, and `NO_PROXY` is
honored. Project-local `httpProxy` is ignored. `/reload` applies changed settings
for subsequent requests while old clients drain active requests. Shutdown stops
messaging and Harness work before releasing owned HTTP resources. Standalone
callers with injected runtimes retain transport control; deliberate fetch
overrides and dispatchers owned by other callers are not replaced on cleanup.

Pi settings in the agent directory and `WORKING_DIR/.pi/settings.json` supply
request policy; `/reload` refreshes it. `retry.provider.timeoutMs` overrides the
provider request timeout, otherwise `httpIdleTimeoutMs` supplies that default
(300000 ms; 0 uses Pi's effectively unlimited value). This forwards a request
option to supporting providers. Separately, application HTTP transport uses
`httpIdleTimeoutMs` for native header/body inactivity timers; 0 disables those
timers. An explicit provider request timeout can still limit a request when
socket-idle timers are disabled. Provider retry limits/delay caps and `retry`
generation policy are executed by Pi/Durable; transport remains SSE. These do
not replace the old host activity timer, prompt maximum-duration or
compaction-deadline behavior.

Web defaults to localhost:7750 and has no authentication. Never expose it to
untrusted networks.

Lifecycle logs use ISO timestamps on stdout/stderr: application startup (PID,
Node version and workspace), agent readiness/reload, the actual Web bind address
or disabled state, messaging readiness (cursor and poll/compaction intervals),
shutdown signal, resource cleanup and failures. Readiness is logged only after
the corresponding initialization succeeds; it is not a model or delivery health
check. Idle polls do not produce log lines. These lifecycle entries do not include
message text, tool arguments or proxy/auth configuration.
The generated launchd job redirects both streams to `WORKING_DIR/service.log`.
Foreground runs use the terminal or the controller's selected redirection; the
application does not open a second log file.

## npm publishing

The public package contains compiled JavaScript and Web assets, not a TypeScript
executable under `node_modules`. `npm pack` builds through `prepack`;
`npm run test:package` verifies the packed executable and inert installer in a
temporary HOME/workspace without models or Messages.

`.github/workflows/publish.yml` uses the existing npm trusted publisher with
GitHub OIDC, Node 24 and `id-token: write`; no local npm login or token is needed.
It runs the full checks, tests and package smoke before publishing with provenance.
Future releases push a matching `v<package-version>` tag. To publish an existing
version after fixing packaging, dispatch the workflow on main with that exact
version; never move an already published GitHub tag.

```sh
gh workflow run publish.yml --ref main -f version=1.0.0
```

An installed npm service runs `dist/cli.js`; source deployments continue to use
`src/cli.ts`. Package installation does not start or reload a service.
