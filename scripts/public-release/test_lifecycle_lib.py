import base64
import pathlib
import tempfile
import unittest
import sys

if sys.platform=='linux':
    from lifecycle_lib import InstallError, create_master_key, require_directory


@unittest.skipUnless(sys.platform=='linux','Linux ownership and directory checks')
class LifecycleHelpersTest(unittest.TestCase):
    def test_master_key_is_never_rotated_or_recreated_over_existing_state(self):
        import os
        if os.geteuid()!=0: self.skipTest('isolated root-only key ownership test')
        with tempfile.TemporaryDirectory(prefix='ptvault-install-test-') as folder:
            root=pathlib.Path(folder); state=root/'state'; state.mkdir(mode=0o700)
            key=root/'master.key'; create_master_key(key,state); original=key.read_bytes()
            create_master_key(key,state); self.assertEqual(key.read_bytes(),original)
            self.assertEqual(len(base64.b64decode(original)),32)
            (state/'installation.json').write_text('{}'); key.unlink()
            with self.assertRaisesRegex(InstallError,'ORIGINAL_KEY_MISSING'): create_master_key(key,state)
            self.assertFalse(key.exists())

    def test_directory_aliases_are_not_accepted(self):
        with tempfile.TemporaryDirectory(prefix='ptvault-install-test-') as folder:
            root=pathlib.Path(folder); (root/'real').mkdir(); (root/'alias').symlink_to(root/'real',target_is_directory=True)
            with self.assertRaisesRegex(InstallError,'PATH_UNSAFE'): require_directory(root/'alias')


if __name__=='__main__': unittest.main()
