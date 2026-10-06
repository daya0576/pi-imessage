# Conversation-owned browser

The host's built-in native Durable `browser` extension implements ADR 0017. It is
registered with the other built-in tools, not loaded as a personal workspace
business extension. It invokes the installed `PI_CODING_AGENT_DIR/bin/pi-browser`
wrapper and its pinned Playwright CLI by argv; there is no SDK shim, private CLI
import or second browser driver.

## Operations

`browser` takes `action` and only the arguments needed by that action:

- `open`, `goto`, `tab-new`: optional `url` (`goto` requires one), HTTP(S) without credentials.
- `snapshot`, `screenshot`: optional `ref` from the latest snapshot.
- `click`, `hover`, `check`, `uncheck`: required `ref`.
- `fill`, `select`: required `ref` and `text`.
- `press`: required `key`.
- `tab-select`: required `tab`; `tab-close` accepts an optional index.
- `go-back`, `go-forward`, `tab-list`, `close`: no further arguments.

Open before interacting. A snapshot includes bounded accessibility text with
current refs. Screenshot/other artifact links resolve from the reported private
cwd; the result also gives the absolute output directory. Page output is
untrusted. No attachment, discovery, headed overrides, global cleanup, arbitrary
profile/config/filename, storage export/import or arbitrary code execution is
exposed to the model. Positional text follows `--`, so strings resembling flags
remain literal. Native health checks and read-only subagents do not offer the tool.

## Isolation and retention

Scope is derived from the canonical Durable storage directory and native
conversation ID, never a model-selected session. Ordinary chats, run conversations
and other tool-enabled native conversations receive distinct scope directories:

```text
WORKING_DIR/browser/<sha256-of-canonical-storage>/<conversation-id>/
  owner.json
  home/                    # private HOME/cache/CLI daemon registry
  cwd/.playwright/         # private workspace identity and managed headless config
  state/profiles/owned/    # dedicated non-personal persistent Chrome profile
  state/output/            # snapshots/screenshots
  state/auth.json          # private last completed storage-state checkpoint
```

Browser child processes alone get the private HOME/cwd and a small environment
allowlist. Browser target/config/test environment overrides are not inherited.
Ordinary bash/read keep their original environment. Scope directories are 0700;
authentication checkpoints are 0600, not returned to the model. Public scoped
`state-save`/`state-load` preserve cookie/local-storage login state across browser
restarts alongside the retained profile. Restore before navigating the supplied
URL, not by repeating the navigation. Before orderly close/reopen, a host-only
public scoped session query checks the owned profile and refreshes its checkpoint,
including asynchronous token changes since the last command. Checkpoints publish
by atomic rename, so an interrupted save cannot truncate the last completed state. On recovery a live
owned daemon is checkpointed before cleanup; if it already died, only the last
completed checkpoint is available and may require renewed login. Profiles,
checkpoints and outputs are not automatically deleted. Real-site login expiration
and IndexedDB-based workflows are not guaranteed by the synthetic fixture.

Operations serialize per conversation, while other conversations remain
independent. `/stop` and `/new` close the chat's owned browsers, including run/task
child scopes, after aborting current work and before admitting the next boundary.
Host shutdown stops native work, closes owned sessions, then releases the native
owner lock. Startup closes saved owned sessions after acquiring that lock, before
resuming work.
Only matching ownership markers and scoped `close` are used; malformed ownership
or a cleanup failure is an explicit error, never grounds for global killing or
silent profile deletion.

The tool declares `replay: "unsafe"` even though the host otherwise defaults tools
to safe. A click/press can already have submitted something when its caller is
interrupted. Cancellation/timeout does not prove the effect was undone; do not
blindly retry. Browser calls have request-bound deadlines and await CLI child exit
on cancellation. SIGTERM gets a short grace period, then only that exact owned CLI
child is terminated; this is never a global Chrome/service kill. Raw subprocess
argv/errors (which can contain form contents) are not surfaced, and snapshots are
read with a byte limit.

This is a tool boundary, **not an OS sandbox**. Unrestricted coding tools can
still access host files or invoke another browser process. Stronger containment
requires a separate decision. Never copy a personal Chrome profile, bypass a
CAPTCHA/2FA or perform an unapproved irreversible action.

## Verification

- `test/browser.test.ts` uses a faux model and fake CLI boundary to check native
  registration, forced arguments/environment, forbidden controls, literal flag-like
  form text, owned stop/reset/restart, retention, cancellation and unsafe replay.
- `node --experimental-strip-types ops/browser-smoke.mjs` uses the real installed
  CLI and headless Chrome with temporary profiles and loopback pages. It checks
  same-name sessions, daemon discovery, cookies/local storage, tabs/output files,
  literal arguments, selective cleanup and preserved login checkpoints on reopen.
  It never opens a personal profile, calls a paid model or sends an iMessage.
