"""Fake subprocess boundary, not a memory store. All input/output lives beside this copied fixture."""

import json
import signal
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parent
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as calls:
    calls.write(json.dumps(args) + "\n")
config = json.loads((root / "responses.json").read_text())
command = args[0]
if command == "add" and config.get("reject_write"):
    print("fixture write rejected", file=sys.stderr)
    sys.exit(1)
if command == "load" and config.get("wait"):
    def stop(_signal, _frame):
        (root / "terminated").write_text("terminated")
        sys.exit(1)
    signal.signal(signal.SIGTERM, stop)
    (root / "started").write_text("started")
    time.sleep(60)
    (root / "late-write").write_text("should never happen")
print(json.dumps(config[command]))
