"""Pin the running Node identity; never turn a source deployment into a runtime upgrade."""

import argparse
import ctypes
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile


def running_service():
    service = f"gui/{os.getuid()}/com.kingcrab.pi-imessage"
    result = subprocess.run(["/bin/launchctl", "print", service], capture_output=True, text=True)
    if result.returncode:
        return {}
    pid = re.search(r"^\s*pid = (\d+)$", result.stdout, re.MULTILINE)
    program = re.search(r"^\s*program = (.+)$", result.stdout, re.MULTILINE)
    job_state = re.search(r"^\s*state = (.+)$", result.stdout, re.MULTILINE)
    libraries = re.search(r'^\s*"?DYLD_FALLBACK_LIBRARY_PATH"? => (.*)$', result.stdout, re.MULTILINE)
    paths = re.findall(r'^\s*"?PATH"? => (.*)$', result.stdout, re.MULTILINE)
    state = {"state": job_state[1] if job_state else "", "pid": int(pid[1]) if pid else 0, "program": program[1] if program else "", "libraries": libraries[1] if libraries else "", "path": paths[-1] if paths else ""}
    if pid:
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        library.proc_pidpath.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(4096)
        if not library.proc_pidpath(int(pid[1]), buffer, len(buffer)):
            raise RuntimeError("Running executable cannot be identified; restore its installation before deploying")
        state["executable"] = buffer.value.decode()
    return state


def resolve_runtime(plist, running, override="", libraries=""):
    arguments = plist.get("ProgramArguments", [])
    selected = override or running.get("executable") or (arguments[0] if arguments else "/opt/homebrew/bin/node")
    node = Path(selected).resolve(strict=True)
    if not node.is_file() or not os.access(node, os.X_OK):
        raise RuntimeError("Selected Node is not executable")
    if running.get("executable") and node != Path(running["executable"]).resolve(strict=True):
        raise RuntimeError("Refusing to change the running Node identity; use a separately approved runtime rollout")
    environment = plist.get("EnvironmentVariables", {})
    libraries = libraries or environment.get("DYLD_FALLBACK_LIBRARY_PATH") or str(node.parent.parent / "lib")
    for folder in libraries.split(":"):
        if not Path(folder).is_absolute() or not Path(folder).is_dir():
            raise RuntimeError("Runtime library directories must exist and be absolute")
    return str(node), libraries


def pin_plist(path, node, libraries, running, backup_dir, expected_main=None):
    original = path.read_bytes()
    plist = plistlib.loads(original)
    arguments = plist.get("ProgramArguments", [])
    if len(arguments) < 2 or not arguments[1].endswith("/current/dist/main.js"):
        raise RuntimeError("Unexpected service arguments; refusing to rewrite the LaunchAgent")
    if expected_main is not None and Path(arguments[1]).resolve(strict=True) != expected_main.resolve(strict=True):
        raise RuntimeError("LaunchAgent does not target the configured current release")
    environment = plist.setdefault("EnvironmentVariables", {})
    changed = arguments[0] != node or environment.get("DYLD_FALLBACK_LIBRARY_PATH") != libraries
    node_dir = str(Path(node).parent)
    old_path = environment.get("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
    if old_path.split(":")[0] != node_dir:
        environment["PATH"] = node_dir + ":" + old_path
        changed = True
    arguments[0] = node
    environment["DYLD_FALLBACK_LIBRARY_PATH"] = libraries
    if changed:
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"runtime-plist-before-{os.getpid()}.backup"
        with backup.open("xb") as output:
            os.chmod(backup, 0o600)
            output.write(original)
            output.flush()
            os.fsync(output.fileno())
        descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as output:
                plistlib.dump(plist, output)
                output.flush()
                os.fsync(output.fileno())
            shutil.copymode(path, temporary)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    # Disk may already be pinned after an aborted deployment while launchd still
    # caches the old argv/environment. Reload only inside blue-green's idle handoff.
    return changed or needs_reload(running, node, libraries)


def needs_reload(running, node, libraries):
    return bool(running and (running.get("program") != node or running.get("libraries") != libraries or running.get("path", "").split(":")[0] != str(Path(node).parent)))


def service_ready(running, node, libraries, previous_pid=0):
    return bool(
        running.get("state") == "running"
        and running.get("pid", 0) > 0
        and running["pid"] != previous_pid
        and running.get("executable") == node
        and not needs_reload(running, node, libraries)
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["node", "libraries", "pin", "needs-reload", "ready"])
    parser.add_argument("--previous-pid", type=int, default=0)
    parser.add_argument("--plist", type=Path, default=Path.home() / "Library/LaunchAgents/com.kingcrab.pi-imessage.plist")
    arguments = parser.parse_args()
    running = running_service()
    plist = plistlib.loads(arguments.plist.read_bytes()) if arguments.plist.exists() else {}
    node, libraries = resolve_runtime(plist, running, os.environ.get("NODE_BIN", ""), os.environ.get("DYLD_FALLBACK_LIBRARY_PATH", ""))
    if arguments.action == "ready":
        raise SystemExit(0 if service_ready(running, node, libraries, arguments.previous_pid) else 1)
    elif arguments.action == "node":
        print(node)
    elif arguments.action == "libraries":
        print(libraries)
    elif arguments.action == "needs-reload":
        print(str(needs_reload(running, node, libraries)).lower())
    else:
        workspace = Path(os.environ.get("IMESSAGE_DIR", str(Path.home() / ".pi/imessage")))
        releases = Path(os.environ.get("RELEASE_ROOT", str(workspace / "releases")))
        print(str(pin_plist(arguments.plist, node, libraries, running, workspace / "deployments", releases / "current/dist/main.js")).lower())


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(f"Runtime selection refused: {error}") from None
