#!/usr/bin/env python3
"""Acceptance-gated workspace instruction cleanup; dry run by default.

After verifying the running release's extension capabilities, use --apply and
--accepted-source <full commit SHA>. Retain a private rollback copy and archive
obsolete tool skills outside discovery. Domain/site skills are never touched.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import uuid


def migrate(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True, type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--accepted-source')
    args = parser.parse_args(argv)
    root = args.workspace.resolve(strict=True)
    path = root / 'cron/jobs.json'
    original = path.read_bytes()
    document = json.loads(original)
    if document.get('version') != 1 or not isinstance(document.get('jobs'), list):
        raise ValueError('Unsupported cron configuration; no writes performed')
    replacements = {
        'skills/search/SKILL.md': '共享扩展 web_search（明确 raw 模式）和 fetch_content 的工具说明',
        'skills/search/run.sh': '共享扩展 web_search（明确 raw 模式）',
        'skills/browser/SKILL.md': '共享扩展 browser_session 和 browser 的工具说明',
    }
    changes = 0

    def replace(value):
        nonlocal changes
        if isinstance(value, str):
            for old, new in replacements.items():
                for reference in [str(root / old), old]:
                    changes += value.count(reference)
                    value = value.replace(reference, new)
            return value
        if isinstance(value, list):
            return [replace(item) for item in value]
        if isinstance(value, dict):
            return {key: replace(item) for key, item in value.items()}
        return value

    updated = replace(document)
    obsolete = [root / 'skills' / name for name in ['search', 'browser'] if (root / 'skills' / name).exists()]
    if any(p.is_symlink() or not p.is_dir() for p in obsolete):
        raise ValueError('Refusing non-directory or symlink skill archive')
    print(f'{"apply" if args.apply else "dry-run"}: {changes} references; {len(obsolete)} tool skills; {len(document["jobs"])} jobs retained')
    if not args.apply or not (changes or obsolete):
        return
    if not re.fullmatch(r'[0-9a-f]{40}', args.accepted_source or ''):
        raise ValueError('--apply requires the explicitly accepted running commit SHA')
    active = (root / 'releases/current').resolve(strict=True)
    if f'-{args.accepted_source[:12]}-' not in active.name or not (active / 'dist/headless-extensions.js').is_file():
        raise ValueError('Accepted extension release is not current; no cleanup performed')
    archive = root / 'retired-tool-skills' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    archive.mkdir(parents=True, mode=0o700)
    os.chmod(archive.parent, 0o700)
    backup = archive / 'jobs.json.before'
    with backup.open('xb') as handle:
        os.chmod(backup, 0o600)
        handle.write(original)
        handle.flush()
        os.fsync(handle.fileno())
    if path.read_bytes() != original:
        raise RuntimeError('Cron configuration changed concurrently; retry after inspection')
    if changes:
        temporary = path.with_name('jobs.json.' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('x') as handle:
                os.chmod(temporary, path.stat().st_mode & 0o777)
                json.dump(updated, handle, ensure_ascii=False, indent=2)
                handle.write('\n')
                handle.flush()
                os.fsync(handle.fileno())
            if path.read_bytes() != original:
                raise RuntimeError('Cron configuration changed concurrently; original retained')
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    for skill in obsolete:
        skill.rename(archive / skill.name)
    receipt = {'acceptedSource': args.accepted_source, 'references': changes,
               'archivedSkills': [p.name for p in obsolete],
               'beforeSha256': hashlib.sha256(original).hexdigest(),
               'afterSha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    (archive / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'Archived outside discovery; rollback copy and receipt: {archive}')


if __name__ == '__main__':
    migrate()
