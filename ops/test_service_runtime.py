"""Runtime pinning regressions without launchctl, Messages or live processes."""

from pathlib import Path
import plistlib
import tempfile
import unittest

from service_runtime import needs_reload, pin_plist, resolve_runtime, service_ready


class ServiceRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.nodes = []
        for version in ("old", "new"):
            home = self.root / version
            (home / "bin").mkdir(parents=True)
            (home / "lib").mkdir()
            node = home / "bin/node"
            node.write_text("#!/bin/sh\nexit 0\n")
            node.chmod(0o755)
            self.nodes.append(node)
        self.old, self.new = self.nodes
        self.alias = self.root / "mutable-node"
        self.alias.symlink_to(self.new)
        self.plist = self.root / "service.plist"
        self.original = {
            "Label": "com.kingcrab.pi-imessage",
            "ProgramArguments": [str(self.alias), str(self.root / "releases/current/dist/main.js"), "retained-argument"],
            "EnvironmentVariables": {"PATH": "/usr/bin:/bin", "UNRELATED": "preserved"},
            "KeepAlive": True,
        }
        self.plist.write_bytes(plistlib.dumps(self.original))
        self.running = {"executable": str(self.old), "program": str(self.alias), "path": "/usr/bin:/bin"}

    def test_preserves_actual_node_instead_of_changed_symlink(self):
        node, libraries = resolve_runtime(self.original, self.running)
        self.assertEqual(node, str(self.old))
        self.assertEqual(libraries, str(self.old.parent.parent / "lib"))

    def test_refuses_runtime_change_or_missing_active_executable(self):
        with self.assertRaisesRegex(RuntimeError, "change the running Node"):
            resolve_runtime(self.original, self.running, str(self.new))
        self.old.unlink()
        with self.assertRaises(FileNotFoundError):
            resolve_runtime(self.original, self.running)

    def test_pins_atomically_and_preserves_other_settings_and_private_backup(self):
        node, libraries = resolve_runtime(self.original, self.running)
        backups = self.root / "backups"
        original_bytes = self.plist.read_bytes()
        self.assertTrue(pin_plist(self.plist, node, libraries, self.running, backups))
        current = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(current["ProgramArguments"], [node, *self.original["ProgramArguments"][1:]])
        self.assertEqual(current["EnvironmentVariables"]["UNRELATED"], "preserved")
        self.assertTrue(current["KeepAlive"])
        backup = next(backups.glob("*.backup"))
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backup.read_bytes(), original_bytes)
        # Aborted handoff: disk pinned, but cached launchd argv/env still old.
        self.assertTrue(pin_plist(self.plist, node, libraries, self.running, backups))
        pinned = {"program": node, "libraries": libraries, "path": str(self.old.parent) + ":/usr/bin"}
        self.assertFalse(pin_plist(self.plist, node, libraries, pinned, backups))
        self.assertEqual(len(list(backups.glob("*.backup"))), 1)
        self.assertFalse(needs_reload(pinned, node, libraries))

    def test_readiness_requires_new_running_pid_and_matching_pinned_runtime(self):
        node, libraries = resolve_runtime(self.original, self.running)
        ready = {"state": "running", "pid": 42, "program": node, "executable": node,
                 "libraries": libraries, "path": str(self.old.parent) + ":/usr/bin"}
        self.assertTrue(service_ready(ready, node, libraries, previous_pid=41))
        self.assertFalse(service_ready(ready, node, libraries, previous_pid=42))
        for change in ({"state": "removing"}, {"pid": 0}, {"executable": str(self.new)},
                       {"libraries": ""}, {"program": str(self.alias)}, {"path": "/usr/bin"}):
            with self.subTest(change=change):
                self.assertFalse(service_ready({**ready, **change}, node, libraries, previous_pid=41))

    def test_rejects_unexpected_service_without_mutation(self):
        self.plist.write_bytes(plistlib.dumps({"ProgramArguments": [str(self.old), "other-service"]}))
        original = self.plist.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "Unexpected service"):
            pin_plist(self.plist, str(self.old), str(self.old.parent.parent / "lib"), {}, self.root / "backups")
        self.assertEqual(self.plist.read_bytes(), original)
        self.assertFalse((self.root / "backups").exists())


if __name__ == "__main__":
    unittest.main()
