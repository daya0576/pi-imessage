"""Exercise durable detached-deploy receipts without starting the service."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


class DetachedDeploymentReceiptTest(unittest.TestCase):
    def test_records_verified_exit_and_repairs_failure(self):
        for exit_code in (0, 1):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ops = root / "ops"
                ops.mkdir()
                shutil.copyfile(Path(__file__).with_name("deploy-detached.sh"), ops / "deploy-detached.sh")
                for name, body in (
                    ("deploy-blue-green.sh", f"exit {exit_code}\n"),
                    ("deploy-repair.sh", f"touch '{root / 'repaired'}'\n"),
                ):
                    script = ops / name
                    script.write_text("#!/bin/bash\n" + body)
                    script.chmod(0o755)
                subprocess.run(["git", "init", "-q", str(root)], check=True)
                subprocess.run(["git", "-C", str(root), "add", "ops"], check=True)
                subprocess.run([
                    "git", "-C", str(root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                    "commit", "-qm", "fixture",
                ], check=True)
                environment = {**os.environ, "IMESSAGE_DIR": str(root / "workspace")}
                result = subprocess.run(
                    ["/bin/bash", str(ops / "deploy-detached.sh")], env=environment,
                    text=True, capture_output=True, check=True,
                )
                receipt = Path(result.stdout.strip().split("status=", 1)[1])
                initial = json.loads(receipt.read_text())
                self.assertEqual(initial["status"], "queued")
                self.assertIsNone(initial["exitCode"])
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    current = json.loads(receipt.read_text())
                    if current["status"] in ("completed", "failed"):
                        break
                    time.sleep(0.1)
                self.assertEqual(current["status"], "completed" if exit_code == 0 else "failed")
                self.assertEqual(current["exitCode"], exit_code)
                self.assertEqual(current["sourceSha"], initial["sourceSha"])
                self.assertEqual((root / "repaired").exists(), exit_code != 0)


if __name__ == "__main__":
    unittest.main()
