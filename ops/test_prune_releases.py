import importlib.util
import os
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prune', pathlib.Path(__file__).with_name('prune-releases.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PruningTests(unittest.TestCase):
    def test_alias_paths_protect_current_previous_and_newest_spare(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / 'real'
            root.mkdir()
            alias = pathlib.Path(directory) / 'alias'
            alias.symlink_to(root, target_is_directory=True)
            names = ['pi-imessage-000-current', 'pi-imessage-001-previous', 'pi-imessage-z-old', 'pi-imessage-a-new']
            for index, name in enumerate(names):
                (root / name).mkdir()
                os.utime(root / name, (index + 1, index + 1))
            (root / 'current').symlink_to(alias / names[0])
            (root / 'previous').symlink_to(alias / names[1])
            self.assertEqual(module.plan(alias, alias/'current', alias/'previous'), [(root/names[2]).resolve()])

    def test_broken_reference_refuses_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root/'pi-imessage-old').mkdir()
            (root/'current').symlink_to(root/'missing')
            with self.assertRaises(FileNotFoundError):
                module.plan(root, root/'current', root/'current')

    def test_external_reference_refuses_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)/'releases'
            root.mkdir()
            (root/'current').symlink_to(pathlib.Path(directory))
            with self.assertRaises(ValueError):
                module.plan(root, root/'current', root/'current')


if __name__ == '__main__':
    unittest.main()
