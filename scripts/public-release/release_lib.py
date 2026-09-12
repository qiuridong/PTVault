"""Small, auditable helpers for isolated release builds; never read an installation."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import posixpath
import re
import shutil
import stat
import tarfile
import urllib.parse
import urllib.request
import uuid
import zipfile


class BuildError(RuntimeError):
    pass


def sha256_file(filename: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with filename.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def relative_name(name: str) -> str:
    if not isinstance(name, str) or not name or '\\' in name or '\0' in name:
        raise BuildError('ARCHIVE_ENTRY')
    parts = pathlib.PurePosixPath(name).parts
    if any(part in ('..', '/') or ':' in part for part in parts):
        raise BuildError('ARCHIVE_ENTRY')
    normalized = '/'.join(part for part in parts if part != '.')
    if not normalized:
        raise BuildError('ARCHIVE_ENTRY')
    return normalized


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.username or parsed.password:
            raise BuildError('ARTIFACT_REDIRECT')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_https(url: str):
    opener = urllib.request.build_opener(HttpsRedirect())
    return opener.open(urllib.request.Request(url, headers={'User-Agent':'PTVault-release-builder/1'}), timeout=90)


def cache_artifact(entry: dict, cache: pathlib.Path, *, fetch=fetch_https, limit=256 * 1024 * 1024) -> pathlib.Path:
    filename, url, expected = entry['file'], entry['url'], entry['sha256']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,180}', filename) or not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise BuildError('ARTIFACT_FORMAT')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.fragment:
        raise BuildError('ARTIFACT_URL')
    if cache.is_symlink() or not cache.is_dir():
        raise BuildError('CACHE_DIRECTORY')
    target = cache / filename
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit or sha256_file(target) != expected:
            raise BuildError('CACHE_HASH: ' + filename)
        return target
    partial = cache / ('.' + filename + '.partial-' + uuid.uuid4().hex)
    digest = hashlib.sha256()
    total = 0
    with fetch(url) as response, partial.open('xb') as output:
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise BuildError('DOWNLOAD_LIMIT: ' + filename)
            output.write(chunk)
            digest.update(chunk)
        output.flush()
        os.fsync(output.fileno())
    if digest.hexdigest() != expected:
        raise BuildError('DOWNLOAD_HASH: ' + filename)
    try:
        os.link(partial, target)
    except FileExistsError:
        if target.is_symlink() or not target.is_file() or sha256_file(target) != expected:
            raise BuildError('CACHE_HASH: ' + filename) from None
    partial.unlink()  # Only the newly-created, exact download temporary file.
    return target


def extract_archive(archive: pathlib.Path, destination: pathlib.Path):
    """Extract only a verified software archive into a new directory, not into / or a release."""
    destination.mkdir(mode=0o700)
    seen = set()
    total = 0
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as stream:
            for item in stream.infolist():
                name = relative_name(item.filename)
                mode = item.external_attr >> 16
                if name in seen or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise BuildError('ARCHIVE_ENTRY')
                seen.add(name)
                total += item.file_size
                if len(seen) > 100000 or total > 2 * 1024**3:
                    raise BuildError('ARCHIVE_LIMIT')
            for item in stream.infolist():
                target = destination / relative_name(item.filename)
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with stream.open(item) as source, target.open('xb') as output:
                        shutil.copyfileobj(source, output)
                    target.chmod(0o755 if item.external_attr >> 16 & 0o111 else 0o644)
        return
    with tarfile.open(archive, 'r:*') as stream:
        members = stream.getmembers()
        accepted = []
        for item in members:
            if item.name.rstrip('/') in ('.', '') and item.isdir():
                continue
            name = relative_name(item.name)
            if name in seen or not (item.isfile() or item.isdir() or item.issym() or item.islnk()):
                raise BuildError('ARCHIVE_ENTRY')
            seen.add(name)
            total += item.size
            if len(seen) > 100000 or total > 2 * 1024**3:
                raise BuildError('ARCHIVE_LIMIT')
            if item.issym() or item.islnk():
                if '\\' in item.linkname or item.linkname.startswith('/'):
                    raise BuildError('ARCHIVE_ENTRY')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name) if item.issym() else '', item.linkname))
                relative_name(target)
            accepted.append(item)
        try:
            stream.extractall(destination, members=accepted, filter='data')
        except (tarfile.TarError, OSError) as error:
            raise BuildError('ARCHIVE_ENTRY') from error


def read_regular(filename: pathlib.Path, limit=16 * 1024 * 1024) -> bytes:
    before = filename.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        raise BuildError('SOURCE_CHANGED')
    fd = os.open(filename, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) or len(data) != opened.st_size or (after.st_size, after.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns):
        raise BuildError('SOURCE_CHANGED')
    return data


def copy_public_source(source: pathlib.Path, destination: pathlib.Path) -> dict:
    source = source.resolve(strict=True)
    manifest_bytes = read_regular(source/'PUBLIC_SOURCE_MANIFEST.json')
    manifest = json.loads(manifest_bytes)
    if manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('files'), list) or len(manifest['files']) > 100000:
        raise BuildError('SOURCE_MANIFEST')
    rows = manifest['files']
    # Same compact JSON encoding as the JavaScript exporter, preserving field order.
    digest = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    if digest != manifest.get('sourceDigest'):
        raise BuildError('SOURCE_MANIFEST')
    snapshots = []
    seen = set()
    for row in rows:
        name = relative_name(row['path'])
        if name.casefold() in seen or any(component in ('.git','.rt','.planning','node_modules','进度') for component in name.split('/')):
            raise BuildError('SOURCE_MANIFEST')
        seen.add(name.casefold())
        filename = source/name
        if filename.resolve(strict=True) != filename:
            raise BuildError('SOURCE_CHANGED')
        data = read_regular(filename)
        if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
            raise BuildError('SOURCE_CHANGED: ' + name)
        snapshots.append((name, data))
    destination.mkdir(mode=0o755)
    for name, data in snapshots:
        filename = destination/name
        filename.parent.mkdir(parents=True, exist_ok=True)
        with filename.open('xb') as output:
            output.write(data)
    (destination/'PUBLIC_SOURCE_MANIFEST.json').write_bytes(manifest_bytes)
    return manifest
