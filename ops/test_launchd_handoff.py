"""Run the actual handoff shell function against a simulated launchd race."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class LaunchdHandoffTest(unittest.TestCase):
    def run_handoff(self, scenario):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "service.plist").touch()
            (root / "state.json").write_text(json.dumps({
                "scenario": scenario, "phase": "old", "attempts": 0, "bootouts": 0,
            }))
            (root / "launchctl.py").write_text('''import json, pathlib, sys
root = pathlib.Path(__file__).parent
path = root / "state.json"
state = json.loads(path.read_text())
action = sys.argv[1]
result = 0
if action == "print":
    print("state = " + state["phase"])
    print("pid = " + ("42" if state["phase"] == "running" else "41"))
elif action == "bootout":
    state["bootouts"] += 1
    state["phase"] = "removing"
elif action == "bootstrap":
    state["attempts"] += 1
    if state["scenario"] == "timeout" or state["attempts"] == 1:
        result = 37
        if state["scenario"] == "watchdog":
            state["phase"] = "running"
    else:
        state["phase"] = "running"
else:
    raise AssertionError("Unexpected destructive action: " + action)
path.write_text(json.dumps(state))
raise SystemExit(result)
''')
            (root / "service_runtime.py").write_text('''import json, pathlib, sys
assert sys.argv[1:] == ["ready", "--previous-pid", "41"], sys.argv
state = json.loads((pathlib.Path(__file__).parent / "state.json").read_text())
raise SystemExit(0 if state["phase"] == "running" else 1)
''')
            source = Path(__file__).with_name("deploy-blue-green.sh").read_text()
            function = "start_active_service() {" + source.split("start_active_service() {", 1)[1].split("\n}\n", 1)[0] + "\n}\n"
            script = '''set -euo pipefail
SERVICE=test-service
SERVICE_PLIST="$TEST_ROOT/service.plist"
SCRIPT_DIR="$TEST_ROOT"
RUNTIME_PLIST_CHANGED=true
START_TIMEOUT_SECONDS=3
launchctl() { /usr/bin/python3 "$TEST_ROOT/launchctl.py" "$@"; }
log() { printf '%s\\n' "$*"; }
# Advance the shell clock without sleeping or touching a real service.
sleep() { SECONDS=$((SECONDS + $1)); }
''' + function + '\nif start_active_service; then exit 0; else exit 1; fi\n'
            result = subprocess.run(["/bin/bash", "-c", script],
                                    env={**os.environ, "TEST_ROOT": str(root)},
                                    text=True, capture_output=True, timeout=10)
            state = json.loads((root / "state.json").read_text())
            self.assertEqual(state["bootouts"], 1)
            return result, state

    def test_retries_error_37_despite_printable_removing_old_job(self):
        result, state = self.run_handoff("race")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(state["attempts"], 2)
        self.assertEqual(state["phase"], "running")
        self.assertIn("Pinned replacement process running", result.stdout)

    def test_accepts_watchdog_replacement_only_after_running_pid_check(self):
        result, state = self.run_handoff("watchdog")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(state["attempts"], 1)
        self.assertEqual(state["phase"], "running")

    def test_printable_old_job_never_counts_as_success_on_timeout(self):
        result, state = self.run_handoff("timeout")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(state["phase"], "removing")
        self.assertIn("Timed out waiting for pinned replacement process", result.stdout)


if __name__ == "__main__":
    unittest.main()
