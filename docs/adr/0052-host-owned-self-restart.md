# 0052. The host owns its own restart

Status: proposed (owner-requested implementation, 2026-10-24)

**Problem.** A chat assistant restarts the service by writing a controller
script and running it from a `bash` tool call. The host cannot tell that this
call is about to stop it. When the call is still running at the stop, ADR 0041
reruns it on the next start, which launches another controller and stops the
service again (#39: about 70 restarts in eleven minutes). ADR 0051 limits the
damage after the fact; it does not remove the cause, and it aborts any long
tool that two deployments happen to interrupt in a row.

**Example.**

```text
restart_service({ release: "d627232…" })
-> Restart into /Users/clawbot/pi-imessage-releases/d627232… is scheduled;
   the service stops after this call settles. Controller directory:
   /tmp/pi-imessage-restart.Xy12ab. Verify in a later call.
```

The call settles, the host opens the controller in Terminal, the controller
stops the old process and becomes the new one. The next turn verifies the
listener, the log and the running release directory.

**Decision.**

- A built-in `restart_service` tool takes the full commit hash of a prepared
  release directory, a sibling of the running one. It refuses a hash that is not
  a directory with `src/cli.ts`, `node_modules` and `ops/restart.command`, and
  a second request while one is scheduled.
- The tool writes the private controller directory of ops/README.md step 3
  itself: `environment.sh` from the process environment, `control.sh` from the
  process's own PID, start time and command line, and a copy of
  `ops/restart.command` from the target release. The controller deletes
  `environment.sh` after sourcing it.
- The tool returns at once. The host launches the controller only after the
  tool task has settled, so the stop can never interrupt the call that asked
  for it.
- The tool is `replay: "unsafe"`. If it is interrupted anyway, the model gets
  an interrupted result and checks what is running instead of a rerun
  launching a second controller.
- Ordinary tools keep the rerun default of ADR 0041. Operators keep the manual
  procedure for a cold start when no service is running.

**Consequences.** A self-restart costs one restart and no extra model turn.
The stop still happens at a tool boundary of the requesting chat, so that chat's
next model request is repeated after the restart, as ADR 0041 accepts. The
restart loop of #39 cannot recur through this tool; ADR 0051 is no longer
needed for it and becomes a decision about long tools only. A chat that writes
its own controller through `bash` is still subject to the ops rule of ending
the call right after `open`.
