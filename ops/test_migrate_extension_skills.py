import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migration', pathlib.Path(__file__).with_name('migrate-extension-skills.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class SkillCleanupTest(unittest.TestCase):
    def test_acceptance_gate_preserves_tasks_and_site_rules_with_reversible_idempotent_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'cron').mkdir()
            for name in ['search', 'browser-task', 'home-assistant']:
                (root / 'skills' / name).mkdir(parents=True)
                (root / 'skills' / name / 'SKILL.md').write_text('rules')
            document = {'version': 1, 'jobs': [
                {'id': 'watch', 'enabled': False, 'action': {'type': 'prompt', 'prompt': '每次使用 skills/search/run.sh 核查。'}},
                {'id': 'newsletter', 'action': {'type': 'exec', 'argv': ['/usr/bin/curl', '--data-raw', json.dumps({'prompt': '先读 skills/search/SKILL.md。', 'ephemeral': True})]}},
            ]}
            path = root / 'cron/jobs.json'
            original = json.dumps(document).encode()
            path.write_bytes(original)
            base = ['--workspace', str(root)]
            migration.migrate(base)
            self.assertEqual(path.read_bytes(), original)
            with self.assertRaises(ValueError):
                migration.migrate(base + ['--apply'])
            release = root / 'releases/pi-imessage-0.0.43-aaaaaaaaaaaa-test'
            (release / 'dist').mkdir(parents=True)
            (release / 'dist/headless-extensions.js').write_text('accepted')
            (root / 'releases/current').symlink_to(release)
            apply = base + ['--apply', '--accepted-source', 'a' * 40]
            migration.migrate(apply)
            updated = json.loads(path.read_text())
            self.assertFalse(updated['jobs'][0]['enabled'])
            self.assertIn('web_search', updated['jobs'][0]['action']['prompt'])
            nested = json.loads(updated['jobs'][1]['action']['argv'][-1])
            self.assertTrue(nested['ephemeral'])
            self.assertIn('web_search', nested['prompt'])
            self.assertTrue((root / 'skills/browser-task/SKILL.md').exists())
            self.assertTrue((root / 'skills/home-assistant/SKILL.md').exists())
            self.assertFalse((root / 'skills/search').exists())
            backup = next((root / 'retired-tool-skills').glob('*/jobs.json.before'))
            self.assertEqual(backup.read_bytes(), original)
            before = path.read_bytes()
            migration.migrate(apply)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(len(list((root / 'retired-tool-skills').iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
