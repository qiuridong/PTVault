#!/usr/bin/env python3
"""Build a Linux public release from a manifest-bound source export and verified runtime."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.parse

from release_lib import BuildError, copy_public_source, read_regular, relative_name, sha256_file
from build_runtime import copy_file, run
from go_licenses import collect_age_dependencies


def inventory(root: pathlib.Path) -> list[dict]:
    rows=[]
    for item in sorted(root.rglob('*')):
        name=item.relative_to(root).as_posix(); info=item.lstat()
        if item.is_symlink():
            if os.path.isabs(os.readlink(item)) or not item.resolve(strict=True).is_relative_to(root):
                raise BuildError('RELEASE_LINK')
            rows.append({'path':name,'link':os.readlink(item)})
        elif item.is_file():
            if info.st_nlink != 1: raise BuildError('RELEASE_FILE')
            rows.append({'path':name,'bytes':info.st_size,'sha256':sha256_file(item),'mode':0o755 if info.st_mode & 0o111 else 0o644})
        elif not item.is_dir(): raise BuildError('RELEASE_FILE')
    return rows


def verify_tree(root: pathlib.Path, rows: list[dict]):
    root=root.resolve(strict=True)
    seen=set()
    for row in rows:
        try: name=relative_name(row['path'])
        except (BuildError,KeyError,TypeError): raise BuildError('RELEASE_PATH') from None
        if name != row['path'] or name in seen: raise BuildError('RELEASE_PATH')
        seen.add(name); item=root/name
        # File parents may not redirect into another tree, even if the leaf is regular.
        if item.parent.resolve(strict=True) != item.parent: raise BuildError('RELEASE_PATH')
        info=item.lstat()
        if 'link' in row:
            if not item.is_symlink() or os.readlink(item) != row['link'] or os.path.isabs(row['link']) or not item.resolve(strict=True).is_relative_to(root): raise BuildError('RELEASE_LINK')
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != row['bytes'] or sha256_file(item) != row['sha256']:
            raise BuildError('RELEASE_FILE: '+name)
        elif os.name != 'nt' and 'mode' in row and (info.st_mode & 0o777) != row['mode']:
            raise BuildError('RELEASE_MODE: '+name)


def copy_verified_runtime(built: pathlib.Path, output: pathlib.Path, lock: pathlib.Path, helper: pathlib.Path) -> dict:
    manifest=json.loads(read_regular(built/'RUNTIME_MANIFEST.json'))
    if manifest.get('schemaVersion') != 1 or manifest.get('platform') != 'linux-x64' or manifest.get('runtimeLockSha256') != sha256_file(lock):
        raise BuildError('RUNTIME_SOURCE_CHANGED')
    verify_tree(built/'runtime',manifest['runtimeFiles'])
    if sha256_file(built/'runtime/archive/archive-sandbox.py') != sha256_file(helper): raise BuildError('RUNTIME_SOURCE_CHANGED')
    output.mkdir()
    for row in manifest['runtimeFiles']:
        target=output/row['path']; target.parent.mkdir(parents=True,exist_ok=True)
        if 'link' in row: target.symlink_to(row['link'])
        else: copy_file(built/'runtime'/row['path'],target,0o755 if (built/'runtime'/row['path']).stat().st_mode & 0o111 else 0o644)
    verify_tree(output,manifest['runtimeFiles'])
    return manifest


def make_archive(source: pathlib.Path, output: pathlib.Path, name: str):
    # Stable archive metadata, not a claim that upstream toolchain outputs are reproducible.
    def fixed(info):
        if not (info.isfile() or info.isdir() or info.issym()): raise BuildError('RELEASE_ARCHIVE_ENTRY')
        info.uid=info.gid=0; info.uname=info.gname='root'; info.mtime=0
        info.mode=0o755 if info.isdir() or info.issym() or info.mode & 0o111 else 0o644
        info.pax_headers={}
        return info
    with output.open('xb') as raw, gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0,compresslevel=6) as compressed, tarfile.open(fileobj=compressed,mode='w',format=tarfile.PAX_FORMAT,dereference=False) as archive:
        archive.add(source,arcname=name,filter=fixed)


def trim_native_build_files(modules: pathlib.Path):
    # Only generated native build intermediates contain builder home/toolchain paths.
    # Keep runtime .node files, the packages' original source and every license file.
    for package in ['argon2','better-sqlite3']:
        build=modules/package/'build'
        if not build.is_dir(): continue
        keep={str(item.relative_to(build)) for item in build.glob('Release/*.node')}
        for item in sorted(build.rglob('*'),key=lambda p:len(p.parts),reverse=True):
            relative=str(item.relative_to(build))
            if item.is_symlink() or item.is_file():
                if relative not in keep: item.unlink()
            elif item.is_dir() and not any(item.iterdir()): item.rmdir()


def npm_inventory(release: pathlib.Path, lock: dict) -> list[dict]:
    records=[]
    for name, entry in sorted(lock['packages'].items()):
        if not name.startswith('node_modules/') or entry.get('link') or not (release/name/'package.json').is_file(): continue
        metadata=json.loads(read_regular(release/name/'package.json'))
        if metadata['version'] != entry['version']: raise BuildError('NPM_LOCK_MISMATCH')
        url=urllib.parse.urlsplit(entry['resolved'])
        if url.scheme != 'https' or url.hostname != 'registry.npmjs.org' or url.username or url.query or url.fragment or url.port:
            raise BuildError('NPM_REGISTRY')
        files=[p for p in sorted((release/name).iterdir()) if p.is_file()]
        licenses=[p.relative_to(release).as_posix() for p in files if re.match(r'^(license|licence|copying|notice)([._-]|$)',p.name,re.I)]
        if not licenses:
            # Some upstream archives put the full notice in a README/source header,
            # or only declare their license and authors in package metadata.
            # Retain that evidence verbatim instead of reporting an empty notice list.
            licenses=[p.relative_to(release).as_posix() for p in files if p.name=='package.json' or re.match(r'^readme([._-]|$)',p.name,re.I)]
            for item in files:
                if item.suffix=='.js' and item.stat().st_size<=2*1024*1024 and re.search(rb'copyright|permission is hereby|redistribution and use',read_regular(item)[:16384],re.I):
                    licenses.append(item.relative_to(release).as_posix())
        records.append({'path':name,'name':metadata['name'],'version':metadata['version'],'license':metadata.get('license',metadata.get('licenses','See package source')),'author':metadata.get('author'),'contributors':metadata.get('contributors',[]),'source':entry['resolved'],'integrity':entry['integrity'],'licenseFiles':licenses})
    return records


def collect_licenses(clean: pathlib.Path, release: pathlib.Path, built_runtime: pathlib.Path, runtime: dict) -> list[dict]:
    packages=npm_inventory(clean,json.loads(read_regular(clean/'package-lock.json')))
    for package in packages:
        targets=[]
        for name in package['licenseFiles']:
            target=pathlib.Path('licenses/npm')/name.removeprefix('node_modules/')
            copy_file(clean/name,release/target)
            targets.append(target.as_posix())
        package['licenseFiles']=targets
    entry=runtime['inputs']['rcloneVendor']
    vendor=built_runtime/'third-party-sources'/entry['file']
    if sha256_file(vendor)!=entry['sha256']: raise BuildError('VENDOR_SOURCE_CHANGED')
    seen=set()
    with tarfile.open(vendor,'r:*') as archive:
        for item in archive:
            if not item.isfile() or not re.match(r'^(license|licence|copying|notice|patents)([._-]|$)',pathlib.PurePosixPath(item.name).name,re.I): continue
            name=relative_name(item.name)
            if name in seen or item.size>2*1024*1024 or len(seen)>=2000: raise BuildError('VENDOR_LICENSE_ENTRY')
            seen.add(name); stream=archive.extractfile(item)
            if stream is None: raise BuildError('VENDOR_LICENSE_ENTRY')
            data=stream.read(item.size+1)
            if len(data)!=item.size: raise BuildError('VENDOR_LICENSE_ENTRY')
            target=release/'licenses/rclone-dependencies'/name
            target.parent.mkdir(parents=True,exist_ok=True)
            with target.open('xb') as output: output.write(data)
    if len(seen)<10: raise BuildError('VENDOR_LICENSES_MISSING')
    return packages


def build(source: pathlib.Path, built_runtime: pathlib.Path, output: pathlib.Path):
    if sys.platform != 'linux' or platform.machine() not in ('x86_64','amd64'): raise BuildError('BUILD_REQUIRES_LINUX_X64')
    if not output.is_absolute() or output.exists() or output.is_symlink(): raise BuildError('BUILD_OUTPUT_NEW_ABSOLUTE_REQUIRED')
    output.mkdir(mode=0o755)
    clean=output/'source'; source_manifest=copy_public_source(source,clean)
    version=source_manifest['version']
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?',version): raise BuildError('RELEASE_VERSION')
    release=output/'release'; release.mkdir()
    runtime=copy_verified_runtime(built_runtime,release/'runtime',clean/'scripts/public-release/runtime-lock.json',clean/'deploy/archive-sandbox.py')
    node=release/'runtime/node/bin/node'; npm=node.parent/'npm'
    env={key:os.environ[key] for key in ['HOME','PATH','TMPDIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'] if key in os.environ}
    env.update({'PATH':str(node.parent)+':'+env.get('PATH','/usr/bin:/bin'),'LANG':'C.UTF-8','LC_ALL':'C.UTF-8',
                'npm_config_build_from_source':'true','npm_config_nodedir':str(node.parent.parent),'npm_config_jobs':'2'})
    if run([node,'--version'],capture=True).strip() != 'v'+runtime['versions']['node']: raise BuildError('NODE_VERSION')
    run([npm,'ci','--no-audit','--no-fund'],cwd=clean,env=env)
    run([npm,'run','build'],cwd=clean,env=env)
    # A second, independent production-only installation; never ship the build dependency tree.
    for name in ['package.json','package-lock.json','apps/api/package.json','apps/web/package.json','packages/contracts/package.json']:
        copy_file(clean/name,release/name)
    run([npm,'ci','--omit=dev','--workspace=@ptvault/api','--workspace=@ptvault/contracts','--include-workspace-root=false','--no-audit','--no-fund'],cwd=release,env=env)
    for name in ['apps/api/dist','apps/web/dist','packages/contracts/dist']:
        shutil.copytree(clean/name,release/name,symlinks=False)
    trim_native_build_files(release/'node_modules')
    smoke="import Database from 'better-sqlite3';import argon2 from 'argon2';const db=new Database(':memory:');for(let i=0;i<10000;i++)db.prepare('select ? as n').get(i);if(!await argon2.verify(await argon2.hash('release-fixture'),'release-fixture'))throw Error('ARGON2');db.close();console.log(JSON.stringify({node:process.version,abi:process.versions.modules,ok:true}));"
    run([node,'--input-type=module','-e',smoke],cwd=release,env=env)
    run([node,release/'apps/api/dist/cli/public.js','help'],cwd=release,env=env)
    for name in ['README.md','LICENSE','PUBLIC_SOURCE_MANIFEST.json']:
        copy_file(clean/name,release/name)
    shutil.copytree(clean/'scripts/public-release',release/'scripts/public-release',ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(built_runtime/'licenses',release/'licenses')
    copy_file(built_runtime/'RUNTIME_MANIFEST.json',release/'RUNTIME_MANIFEST.json')
    packages=collect_licenses(clean,release,built_runtime,runtime)
    copy_file(clean/'scripts/public-release/templates/npm-additional-notices.md',release/'licenses/npm/ADDITIONAL_NOTICES.md')
    copy_file(clean/'scripts/public-release/templates/THIRD_PARTY_NOTICES.md',release/'THIRD_PARTY_NOTICES.md')
    (release/'NPM_COMPONENTS.json').write_text(json.dumps(packages,ensure_ascii=False,indent=2)+'\n')
    sources=output/'corresponding-sources'; sources.mkdir()
    collect_age_dependencies(built_runtime,runtime,release,sources/'age-go-modules')
    # The verified upstream source inputs and exact build options accompany every binary.
    shutil.copytree(built_runtime/'third-party-sources',sources/'runtime')
    shutil.copytree(release/'licenses',sources/'licenses')
    copy_public_source(source,sources/'ptvault')
    copy_file(release/'RUNTIME_MANIFEST.json',sources/'RUNTIME_MANIFEST.json')
    copy_file(release/'NPM_COMPONENTS.json',sources/'NPM_COMPONENTS.json')
    copy_file(release/'GO_COMPONENTS.json',sources/'GO_COMPONENTS.json')
    for item in packages:
        # Runtime npm packages already retain their public source and licenses in the release.
        # Pin their distribution URLs + integrity so consumers can independently obtain them.
        if not isinstance(item['integrity'],str) or not item['integrity'].startswith('sha512-'): raise BuildError('NPM_INTEGRITY')
    rows=inventory(release)
    manifest={'schemaVersion':1,'product':'PTVault-public','version':version,'platform':'linux-x64','databaseSchema':42,
              'sourceDigest':source_manifest['sourceDigest'],'runtimeVersions':runtime['versions'],'files':rows}
    (release/'RELEASE_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    verify_tree(release,rows)
    assets=output/'assets'; assets.mkdir()
    for folder,suffix in [(release,'linux-x64'),(sources,'sources')]:
        name='ptvault-'+version+'-'+suffix
        make_archive(folder,assets/(name+'.tar.gz'),name)
    (assets/'SHA256SUMS').write_text(''.join(sha256_file(item)+'  '+item.name+'\n' for item in sorted(assets.glob('*.tar.gz'))))
    print(json.dumps({'ok':True,'stage':'RELEASE_BUILT_NOT_INSTALLED','version':version,'sourceDigest':source_manifest['sourceDigest'],'files':len(rows),'npmPackages':len(packages)}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True,type=pathlib.Path)
    parser.add_argument('--runtime',required=True,type=pathlib.Path)
    parser.add_argument('--output',required=True,type=pathlib.Path)
    args=parser.parse_args()
    try: build(args.source,args.runtime,args.output)
    except (BuildError,OSError,ValueError,subprocess.SubprocessError) as error:
        print('RELEASE_BUILD_FAILED: '+(str(error) if isinstance(error,BuildError) else type(error).__name__),file=sys.stderr); sys.exit(1)
