import hashlib
import io
import json
import pathlib
import tempfile
import unittest
import tarfile
import zipfile

from release_lib import BuildError, cache_artifact, extract_archive, copy_public_source
from build_runtime import profile_from_source


class ReleaseHelpersTest(unittest.TestCase):
    def test_client_profile_is_data_from_the_exact_pinned_source(self):
        source = b'ClientID string `default:"public-id"`\nClientSecret string `default:"public-secret"`\n'
        fingerprint=hashlib.sha256(b'public-id\0public-secret').hexdigest()
        lock={'artifacts':{'baiduProfileSource':{'sha256':hashlib.sha256(source).hexdigest()}},
              'baiduProfile':{'profileId':'fixture-public','sourceCommit':'a'*40,'clientFingerprint':fingerprint}}
        value=profile_from_source(source,lock)
        self.assertEqual(value['clientFingerprint'],fingerprint)
        self.assertIsNone(value['appId'])
        self.assertEqual(value['clientId'],'public-id')
        with self.assertRaisesRegex(BuildError,'PROFILE_SOURCE_HASH'):
            profile_from_source(source+b'changed',lock)
        lock['baiduProfile']['clientFingerprint']='f'*64
        with self.assertRaisesRegex(BuildError,'PROFILE_FINGERPRINT'):
            profile_from_source(source,lock)

    def test_cache_is_verified_and_never_reuses_changed_or_incomplete_bytes(self):
        with tempfile.TemporaryDirectory(prefix='ptvault-release-') as folder:
            cache = pathlib.Path(folder)
            body = b'official fixture'
            entry = {'file':'fixture.tar.xz', 'url':'https://nodejs.org/fixture', 'sha256':hashlib.sha256(body).hexdigest()}
            calls = []
            def fetch(url):
                calls.append(url)
                return io.BytesIO(body)
            result = cache_artifact(entry, cache, fetch=fetch)
            self.assertEqual(result.read_bytes(), body)
            self.assertEqual(cache_artifact(entry, cache, fetch=fetch), result)
            self.assertEqual(len(calls), 1)
            result.write_bytes(b'changed')
            with self.assertRaisesRegex(BuildError,'CACHE_HASH'):
                cache_artifact(entry, cache, fetch=fetch)
            self.assertEqual(result.read_bytes(), b'changed')
            wrong = dict(entry, file='wrong.tar.xz', sha256='f'*64)
            with self.assertRaisesRegex(BuildError,'DOWNLOAD_HASH'):
                cache_artifact(wrong, cache, fetch=fetch)
            self.assertFalse((cache/'wrong.tar.xz').exists())

    def test_download_limit_and_insecure_url_fail_before_ready_file(self):
        with tempfile.TemporaryDirectory(prefix='ptvault-release-') as folder:
            cache = pathlib.Path(folder)
            entry={'file':'fixture', 'url':'https://nodejs.org/fixture','sha256':'f'*64}
            with self.assertRaisesRegex(BuildError,'DOWNLOAD_LIMIT'):
                cache_artifact(entry, cache, fetch=lambda url:io.BytesIO(b'x'*11), limit=10)
            with self.assertRaisesRegex(BuildError,'ARTIFACT_URL'):
                cache_artifact(dict(entry,url='http://nodejs.org/fixture'), cache, fetch=lambda url:self.fail('must not fetch'))
            self.assertFalse((cache/'fixture').exists())

    def test_archive_cannot_escape_or_install_device_entries(self):
        with tempfile.TemporaryDirectory(prefix='ptvault-release-') as folder:
            root=pathlib.Path(folder)
            for name, kind in [('../outside',tarfile.REGTYPE), ('device',tarfile.CHRTYPE)]:
                archive=root/('bad'+str(len(list(root.iterdir())))+'.tar')
                with tarfile.open(archive,'w') as stream:
                    item=tarfile.TarInfo(name); item.type=kind
                    stream.addfile(item)
                with self.assertRaisesRegex(BuildError,'ARCHIVE_ENTRY'):
                    extract_archive(archive,root/(archive.stem+'-out'))
            zip_path=root/'bad.zip'
            with zipfile.ZipFile(zip_path,'w') as stream:stream.writestr('../outside',b'bad')
            with self.assertRaisesRegex(BuildError,'ARCHIVE_ENTRY'):
                extract_archive(zip_path,root/'zip-out')
            self.assertFalse((root.parent/'outside').exists())

    def test_only_manifest_bound_source_is_copied_and_rechecks_digest(self):
        with tempfile.TemporaryDirectory(prefix='ptvault-release-') as folder:
            root=pathlib.Path(folder); source=root/'source'; source.mkdir()
            data=b'public source\n'; (source/'safe.ts').write_bytes(data)
            (source/'private.txt').write_text('private')
            rows=[{'path':'safe.ts','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}]
            manifest={'schemaVersion':1,'version':'0.1.0','files':rows,'sourceDigest':hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()}
            (source/'PUBLIC_SOURCE_MANIFEST.json').write_text(json.dumps(manifest))
            copy_public_source(source,root/'copy')
            self.assertEqual((root/'copy'/'safe.ts').read_bytes(),data)
            self.assertFalse((root/'copy'/'private.txt').exists())
            (source/'safe.ts').write_bytes(b'changed')
            with self.assertRaisesRegex(BuildError,'SOURCE_CHANGED'):
                copy_public_source(source,root/'wrong')


if __name__ == '__main__':unittest.main()
