#!/usr/bin/env python3
"""Prune only old direct release directories; default is a read-only plan."""
import argparse
import pathlib
import shutil


def plan(root, current, previous):
    root = pathlib.Path(root).resolve(strict=True)
    # Broken or unexpected references fail closed: do not delete any release.
    protected = {pathlib.Path(current).resolve(strict=True), pathlib.Path(previous).resolve(strict=True)}
    if any(p.parent != root or not p.is_dir() for p in protected):
        raise ValueError('release reference is outside the direct release root')
    candidates = [p for p in root.iterdir() if p.name.startswith('pi-imessage-') and not p.is_symlink() and p.is_dir()]
    spares = sorted((p for p in candidates if p not in protected), key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    return spares[1:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root')
    parser.add_argument('current')
    parser.add_argument('previous')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        stale = plan(args.root, args.current, args.previous)
        for candidate in stale:
            # A concurrently changed reference can only make cleanup more conservative.
            if candidate not in plan(args.root, args.current, args.previous):
                continue
            print(('remove ' if args.apply else 'would remove ') + str(candidate))
            if args.apply:
                shutil.rmtree(candidate)
    except (OSError, ValueError) as error:
        print('Release cleanup skipped: ' + type(error).__name__)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
