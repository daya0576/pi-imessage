# 0017. Invoke browser CLI in a native conversation-owned scope

Status: proposed (2026-10-05). Replaces only the browser-through-unrestricted-bash part of proposed [0004](0004-native-extensions.md) if accepted.

**Problem.** `PI_BROWSER_HOME` scopes the pi-browser wrapper's profiles/output, not Playwright CLI's daemon registry. CLI 0.1.19 keeps that registry in the user's cache directory, derives daemon workspace identity from `.playwright` or the installed package, and enumerates other workspaces. All chats currently share the same shell environment and working directory. A named session or separate profile directory alone therefore does not preserve the old browser adapter's private-session rules.

**Example.** Two chats both use `-s=task`. Even with different PI_BROWSER_HOME values, they can resolve the same daemon/session and see other registry entries. Giving the model a suggested name is not enforcement.

**Decision.**

- Offer a thin native Durable browser tool that invokes the installed, pinned pi-browser CLI by argv. Do not load an SDK browser extension, emulate ExtensionAPI, vendor CLI internals or implement another browser driver.
- Derive browser scope from canonical storage identity plus native conversation identity, not a model-selected name. Ordinary chats, runs and isolated API/cron contexts get distinct scope; disallowed read-only contexts do not get the tool.
- Give only browser child processes a dedicated HOME, profile/output root and scoped working directory. Leave ordinary coding tools' HOME/cwd unchanged. Use public process/CLI controls rather than PWTEST daemon/socket environment variables. Verify daemon discovery and attachment cannot escape the scope, including environment-inherited external browser targets.
- Always select the owned session/profile and headless mode. Deny attachment/discovery, global close/kill, arbitrary profile/config paths and headed overrides, retaining the old service's restrictions. Expose the ordinary browsing operations needed by the product through validated arguments; operation results remain untrusted data.
- Close owned browsers at the agreed stop/shutdown boundaries without touching unrelated sessions. Track only external browser resources and cleanup facts, not a second task state machine. Define restart cleanup and privacy retention before claiming isolation. Do not silently delete saved login profiles or replay uncertain browser mutations.
- Do not mistake this tool boundary for an OS sandbox: unrestricted bash/read can still access host files and invoke other executables. State that limit explicitly; stronger containment requires a separate decision.

**Consequences.** Native tool registration replaces browser instructions as the enforcement boundary for normal product use. The browser skill can still explain workflows, but cannot be the sole privacy mechanism. Actual Chrome/CLI fixtures must verify same-name sessions in different scopes, registry isolation, profile/config rejection and owned cleanup before release.

**Evidence.** The installed wrapper source separates PI_BROWSER_HOME from Playwright's registry. In a temporary copy installed with the locked manifests (`npm ci --ignore-scripts`), CLI 0.1.19's `cli-client/registry.js` uses OS HOME/cache, scans every workspace and exposes only a PWTEST-specific daemon-root override. A bounded temporary-HOME experiment confirms different PI_BROWSER_HOME values share the daemon directory and registry enumeration sees another synthetic workspace. No browser or personal profile was opened. The experiment describes the pinned implementation; production must not import those private files.

**Rejected.** Profile-directory changes or prompt-only session naming as proof of isolation, private PWTEST controls, changing HOME/cwd for all bash tools, SDK extension adaptation, unscoped global browser cleanup and claiming unrestricted coding tools are sandboxed.
