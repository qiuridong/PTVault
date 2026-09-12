import hashlib
import json
import pathlib
import tempfile
import unittest

from build_release import copy_verified_runtime, inventory, make_archive, npm_inventory, verify_tree
from release_lib import BuildError


class PackageTest(unittest.TestCase):
    def test_npm_notice_inventory_keeps_hyphen_licenses_and_embedded_declarations(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); modules=root/'node_modules'; modules.mkdir()
            entries={}
            for name in ['separate','embedded']:
                package=modules/name; package.mkdir()
                (package/'package.json').write_text(json.dumps({'name':name,'version':'1.0.0','license':'MIT','author':'Upstream Author'}))
                (package/'README.md').write_text('Original upstream license declaration')
                entries['node_modules/'+name]={'version':'1.0.0','resolved':'https://registry.npmjs.org/'+name+'/-/'+name+'-1.0.0.tgz','integrity':'sha512-fixture'}
            (modules/'separate/LICENSE-MIT.txt').write_text('Original permission notice')
            (modules/'embedded/index.js').write_text('/* Copyright upstream; license in source */\nmodule.exports=1;')
            rows={row['name']:row for row in npm_inventory(root,{'packages':entries})}
            self.assertIn('node_modules/separate/LICENSE-MIT.txt',rows['separate']['licenseFiles'])
            for name in ['README.md','package.json','index.js']:
                self.assertIn('node_modules/embedded/'+name,rows['embedded']['licenseFiles'])
            self.assertEqual(rows['embedded']['author'],'Upstream Author')

    def test_inventory_binds_files_permissions_and_internal_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); tree = root/'tree'; tree.mkdir()
            (tree/'app').write_text('public'); (tree/'app').chmod(0o755)
            rows = inventory(tree)
            verify_tree(tree, rows)
            (tree/'app').write_text('changed')
            with self.assertRaisesRegex(BuildError, 'RELEASE_FILE'):
                verify_tree(tree, rows)
            with self.assertRaisesRegex(BuildError, 'RELEASE_PATH'):
                verify_tree(tree, [{'path':'../escape','bytes':0,'sha256':'a'*64,'mode':420}])

    def test_runtime_requires_same_lock_and_sandbox_helper_and_excludes_unlisted_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); runtime=root/'built'; (runtime/'runtime/archive').mkdir(parents=True)
            (runtime/'runtime/archive/archive-sandbox.py').write_bytes(b'helper')
            lock=root/'lock.json'; lock.write_bytes(b'{}')
            rows=inventory(runtime/'runtime')
            manifest={'schemaVersion':1,'platform':'linux-x64','runtimeLockSha256':hashlib.sha256(b'{}').hexdigest(), 'runtimeFiles':rows}
            (runtime/'RUNTIME_MANIFEST.json').write_text(json.dumps(manifest))
            (runtime/'runtime/private').write_text('not listed')
            helper=root/'helper.py'; helper.write_bytes(b'helper')
            copy_verified_runtime(runtime, root/'out', lock, helper)
            self.assertFalse((root/'out/private').exists())
            helper.write_bytes(b'new helper')
            with self.assertRaisesRegex(BuildError,'RUNTIME_SOURCE_CHANGED'):
                copy_verified_runtime(runtime,root/'out2',lock,helper)

    def test_archives_have_stable_metadata_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); src=root/'source'; src.mkdir(); (src/'item').write_text('hello')
            make_archive(src,root/'a.tar.gz','bundle')
            make_archive(src,root/'b.tar.gz','bundle')
            self.assertEqual((root/'a.tar.gz').read_bytes(),(root/'b.tar.gz').read_bytes())
            with self.assertRaises(FileExistsError): make_archive(src,root/'a.tar.gz','bundle')


if __name__ == '__main__': unittest.main()
