# 0016. Initialize one process-owned HTTP transport

Status: accepted (2026-10-05; owner accepted 2026-10-05)

**Problem.** Pi's global `httpProxy` and `httpIdleTimeoutMs` settings need HTTP transport setup, not just request-option forwarding. Coding-agent's experimental Durable startup calls `applyHttpProxySettings()` and `configureHttpDispatcher()`, but neither is a public export of coding-agent 1.0.2. Merely assigning `HTTP_PROXY` and `HTTPS_PROXY` after Node starts does not reconfigure the dispatcher created by `--use-env-proxy`.

**Example.** An operator sets `httpProxy` in Pi settings without shell proxy variables. The service must use that proxy for authentication and model HTTP requests. Setting the variables at service startup can otherwise leave fetch connecting directly. A provider request timeout also does not replace a socket's inactivity timeout.

**Decision.**

- The host owns one process-wide HTTP setup, initialized before opening model/auth runtime. Individual chats and private Harness instances do not install global dispatchers.
- Use public Undici APIs, with an exact direct dependency matching the supported SDK implementation, rather than importing private coding-agent files. Supply the global Pi proxy setting only as environment defaults; retain explicit environment proxy values, lowercase precedence and NO_PROXY behavior. Do not accept project-local proxy overrides where Pi accepts only global configuration.
- Configure native HTTP headers/body idle timeouts from Pi settings, including disabled timeout semantics. Keep transport fetch and dispatcher on the same Undici implementation so compressed responses are decoded consistently. Preserve deliberately supplied fetch implementations. Follow the SDK's connection-family and client-error handling rather than inventing transport retries.
- `/reload` may replace transport for subsequent requests without cancelling active work. Track transport resources in memory only, let active requests finish on their original clients, and retire old clients safely. During shutdown, stop producers and Harness work before releasing transport; restore globals only if they are still ours. Never close a dispatcher owned by another caller.
- Durable/provider retry policy and request timeout options remain unchanged. This setup is not a host activity timer, prompt deadline, compaction deadline, inbox or execution loop.

**Consequences.** Process-global HTTP setup belongs to application lifecycle, not per-conversation configuration. Standalone callers with an injected runtime/fetch keep control of their transport. The implementation must verify proxy precedence/bypass, compressed responses, idle timeout enable/disable, reload with active requests, cleanup and custom-fetch preservation against loopback fixtures before claiming compatibility.

**Evidence.** The installed coding-agent `core/http-dispatcher.js` and experimental [harness setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/experimental/durable/harness-setup.ts) use Undici EnvHttpProxyAgent and matching fetch globals. A bounded Node 26 loopback experiment confirms late environment defaults leave built-in fetch direct, while public Undici 8.10.2 dispatcher plus matching fetch routes through the configured proxy. This establishes an implementation path, not completed lifecycle/timeout behavior or real-provider connectivity.

**Rejected.** Environment mutation as proof of effective transport, request timeout as proof of socket-idle enforcement, private SDK imports, patching installed packages, a new HTTP retry algorithm, and relying on newer Node-only proxy-reset APIs while retaining Node >=22.22.2 support.
