#!/usr/bin/env python3
"""Build a private Linux runtime in a NEW directory; this is not an installer."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys

from release_lib import BuildError, cache_artifact, extract_archive, read_regular, sha256_file


def run(arguments, *, cwd=None, env=None, capture=False, timeout=1800):
    result = subprocess.run([str(value) for value in arguments], cwd=cwd, env=env, check=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, text=True, timeout=timeout)
    return result.stdout if capture else ''


def copy_file(source, destination, mode=0o644):
    if not source.is_file():
        raise BuildError('BUILD_INPUT_MISSING: '+source.name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        raise BuildError('BUILD_DESTINATION_EXISTS')
    shutil.copyfile(source, destination)
    destination.chmod(mode)


def profile_from_source(source: bytes, lock: dict) -> dict:
    entry = lock['artifacts']['baiduProfileSource']
    if hashlib.sha256(source).hexdigest() != entry['sha256']:
        raise BuildError('PROFILE_SOURCE_HASH')
    text = source.decode('utf-8')
    fields = {}
    for field, output in [('ClientID','clientId'), ('ClientSecret','clientSecret')]:
        matches = re.findall(r'\b' + field + r'\s+string[^\n]*?default:"([A-Za-z0-9_-]{1,512})"', text)
        if len(matches) != 1:
            raise BuildError('PROFILE_SOURCE_FORMAT')
        fields[output] = matches[0]
    metadata = lock['baiduProfile']
    fingerprint = hashlib.sha256((fields['clientId'] + '\0' + fields['clientSecret']).encode()).hexdigest()
    if fingerprint != metadata['clientFingerprint']:
        raise BuildError('PROFILE_FINGERPRINT')
    return {'version':2, 'provider':'BAIDU', 'appId':None, **fields,
            'clientProfileId':metadata['profileId'], 'clientFingerprint':fingerprint,
            'sourceCommit':metadata['sourceCommit'], 'sourceSha256':entry['sha256']}


def collect_probe_libraries(prefix: pathlib.Path, probe: pathlib.Path, sources: pathlib.Path,
                            licenses: pathlib.Path, env: dict) -> list[dict]:
    probe.mkdir(parents=True)
    libraries = probe/'lib'
    libraries.mkdir()
    executable = prefix/'bin/ffprobe'
    copy_file(executable, probe/'ffprobe', 0o755)
    dependency_env = dict(env, LD_LIBRARY_PATH=str(prefix/'lib'))
    dependencies = run(['lddtree','-l',executable], env=dependency_env, capture=True).splitlines()
    source_packages = {}
    copied = set()
    for value in dependencies:
        filename = pathlib.Path(value)
        if not filename.is_absolute() or not filename.is_file():
            raise BuildError('PROBE_DEPENDENCY')
        filename = filename.resolve(strict=True)
        if filename == executable.resolve(strict=True):
            continue
        if filename.name == 'ld-linux-x86-64.so.2':
            target = probe/'loader'
        else:
            # lddtree reports the SONAME path before resolving it; retain that basename as a
            # regular file, never a symlink into the builder or the target operating system.
            target = libraries/pathlib.Path(value).name
        if target in copied:
            continue
        copied.add(target)
        copy_file(filename,target,0o755)
        if filename.is_relative_to(prefix):
            continue
        if not (filename.is_relative_to('/usr/lib') or filename.is_relative_to('/lib')):
            raise BuildError('PROBE_EXTERNAL_DEPENDENCY')
        owner_line = run(['dpkg-query','-S',filename],capture=True).strip().splitlines()
        if len(owner_line) != 1 or ': ' not in owner_line[0]:
            raise BuildError('PROBE_DEPENDENCY_PACKAGE')
        owner = owner_line[0].split(': ',1)[0]
        package, version = run(['dpkg-query','-W','-f=${source:Package}\n${source:Version}',owner],capture=True).strip().splitlines()
        if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*',package) or not re.fullmatch(r'[A-Za-z0-9.+:~_-]+',version):
            raise BuildError('PROBE_DEPENDENCY_PACKAGE')
        source_packages[package] = version
        copyright_file = pathlib.Path('/usr/share/doc')/owner.split(':',1)[0]/'copyright'
        license_target = licenses/(owner.replace(':','-')+'-copyright.txt')
        if not license_target.exists():
            copy_file(copyright_file,license_target)
    if not (probe/'loader').is_file():
        raise BuildError('PROBE_LOADER_MISSING')
    # Actual closed-runtime execution, without the builder's ld cache or LD_LIBRARY_PATH.
    run([probe/'loader','--inhibit-cache','--library-path',libraries,probe/'ffprobe','-version'],env=env,capture=True)
    records = []
    for package, version in sorted(source_packages.items()):
        folder = sources/('system-'+package)
        folder.mkdir()
        # This reads the builder's already-enabled, signed Ubuntu deb-src indexes. It does not
        # edit apt sources, install packages, or download a different version as a fallback.
        run(['apt-get','source','--download-only',package+'='+version],cwd=folder,env=env)
        if not list(folder.glob('*.dsc')):
            raise BuildError('DEPENDENCY_SOURCE_MISSING')
        records.append({'package':package,'version':version,'sourceFiles':[
            {'name':item.name,'sha256':sha256_file(item)} for item in sorted(folder.iterdir()) if item.is_file()]})
    return records


def build_runtime(lock_file: pathlib.Path, cache: pathlib.Path, output: pathlib.Path, jobs: int):
    if sys.platform != 'linux' or platform.machine() not in ('x86_64','amd64'):
        raise BuildError('BUILD_REQUIRES_LINUX_X64')
    if not 1 <= jobs <= 4:
        raise BuildError('BUILD_JOBS')
    for command in ['make','gcc','g++','readelf','lddtree','dpkg-query','apt-get']:
        if not shutil.which(command):
            raise BuildError('BUILD_TOOL_MISSING: '+command)
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise BuildError('BUILD_OUTPUT_NEW_ABSOLUTE_REQUIRED')
    lock = json.loads(read_regular(lock_file))
    if lock.get('schemaVersion') != 1 or lock.get('platform') != 'linux-x64':
        raise BuildError('RUNTIME_LOCK_FORMAT')
    cache.mkdir(parents=True,exist_ok=True)
    downloaded = {}
    for name, entry in lock['artifacts'].items():
        print('Verifying runtime input: '+name,flush=True)
        downloaded[name] = cache_artifact(entry,cache)
    output.mkdir(mode=0o755)
    work, runtime = output/'build',output/'runtime'
    sources, licenses = output/'third-party-sources',output/'licenses'
    for directory in [work,runtime,sources,licenses]:directory.mkdir()
    env = {key:os.environ[key] for key in ['PATH','HOME','TMPDIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'] if key in os.environ}
    env.update({'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','SOURCE_DATE_EPOCH':'1789171200'})
    extract_archive(downloaded['node'],work/'node')
    node_source = work/'node'/('node-v'+lock['nodeVersion']+'-linux-x64')
    shutil.copytree(node_source,runtime/'node',symlinks=True)
    if run([runtime/'node/bin/node','--version'],capture=True).strip() != 'v'+lock['nodeVersion']:
        raise BuildError('NODE_VERSION')
    copy_file(node_source/'LICENSE',licenses/'Node.js-LICENSE.txt')
    extract_archive(downloaded['rclone'],work/'rclone')
    rclone_root = work/'rclone'/'rclone-v1.74.4-linux-amd64'
    copy_file(rclone_root/'rclone',runtime/'bin/rclone',0o755)
    extract_archive(downloaded['rcloneSource'],work/'rclone-source')
    copy_file(work/'rclone-source/rclone-v1.74.4/COPYING',licenses/'rclone-COPYING.txt')
    extract_archive(downloaded['age'],work/'age')
    for name in ['age','age-keygen']:
        copy_file(work/'age'/'age'/name,runtime/'bin'/name,0o755)
    copy_file(work/'age'/'age/LICENSE',licenses/'age-LICENSE.txt')
    extract_archive(downloaded['sevenzip'],work/'sevenzip')
    copy_file(work/'sevenzip/7zzs',runtime/'archive/7zzs',0o755)
    for name in ['License.txt','MANUAL/general/license.htm']:
        copy_file(work/'sevenzip'/name,licenses/('7-Zip-'+pathlib.Path(name).name))
    if 'INTERP' in run(['readelf','-l',runtime/'archive/7zzs'],capture=True) or 'NEEDED' in run(['readelf','-d',runtime/'archive/7zzs'],capture=True):
        raise BuildError('SEVENZIP_NOT_STATIC')
    copy_file(lock_file.parent.parent.parent/'deploy/archive-sandbox.py',runtime/'archive/archive-sandbox.py',0o755)
    profile = profile_from_source(read_regular(downloaded['baiduProfileSource']),lock)
    (runtime/'baidu-client.json').write_text(json.dumps(profile,ensure_ascii=False,indent=2)+'\n')
    copy_file(downloaded['baiduProfileLicense'],licenses/'AList-reference-AGPL-3.0.txt')
    for name in ['sevenzipSource','ffmpegSource','rcloneSource','rcloneVendor','ageSource','baiduProfileSource']:
        copy_file(downloaded[name],sources/downloaded[name].name)
    extract_archive(downloaded['ffmpegSource'],work/'ffmpeg')
    ffmpeg = work/'ffmpeg/ffmpeg-8.0.3'
    prefix = work/'ffmpeg-prefix'
    configure = [
        '--prefix='+str(prefix),'--disable-autodetect','--disable-network','--disable-gpl',
        '--disable-nonfree','--disable-version3','--disable-everything','--disable-doc',
        '--disable-debug','--disable-x86asm','--enable-shared','--disable-static',
        '--enable-ffprobe','--enable-avcodec','--enable-avformat','--enable-avutil',
        '--enable-swresample','--enable-swscale','--enable-demuxers','--enable-parsers',
        '--enable-decoders','--enable-protocol=file','--enable-pthreads',
    ]
    run(['./configure',*configure],cwd=ffmpeg,env=env)
    run(['make','-j'+str(jobs)],cwd=ffmpeg,env=env)
    run(['make','install'],cwd=ffmpeg,env=env)
    for name in ['COPYING.LGPLv2.1','LICENSE.md','CREDITS']:
        copy_file(ffmpeg/name,licenses/('FFmpeg-'+name))
    system_sources = collect_probe_libraries(prefix,runtime/'archive/probe',sources,licenses,env)
    for name in ['rclone','age','age-keygen']:
        actual = run([runtime/'bin'/name,'version' if name == 'rclone' else '--version'],capture=True,env=env).strip().splitlines()[0]
        if actual != ('rclone v1.74.4' if name == 'rclone' else 'v1.3.2'):
            raise BuildError('RUNTIME_BINARY_VERSION')
    versions = {'node':lock['nodeVersion'],'rclone':'1.74.4','age':'1.3.2','sevenzip':'26.03','ffmpeg':'8.0.3'}
    manifest = {'schemaVersion':1,'platform':'linux-x64','versions':versions,'runtimeLockSha256':sha256_file(lock_file),
                'inputs':lock['artifacts'],'ffmpegConfigure':['--prefix=BUILD_PREFIX',*configure[1:]],
                'systemSources':system_sources,'runtimeFiles':[]}
    for filename in sorted(runtime.rglob('*')):
        if filename.is_symlink():
            # Node's official npm links are internal. The archive/probe subtree never uses links.
            if not filename.resolve(strict=True).is_relative_to(runtime):raise BuildError('RUNTIME_LINK_ESCAPE')
            manifest['runtimeFiles'].append({'path':str(filename.relative_to(runtime)),'link':os.readlink(filename)})
        elif filename.is_file():
            manifest['runtimeFiles'].append({'path':str(filename.relative_to(runtime)),'bytes':filename.stat().st_size,'sha256':sha256_file(filename)})
    (output/'RUNTIME_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'ok':True,'stage':'RUNTIME_BUILT_NOT_INSTALLED','versions':versions,'files':len(manifest['runtimeFiles'])}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache',required=True,type=pathlib.Path)
    parser.add_argument('--output',required=True,type=pathlib.Path)
    parser.add_argument('--jobs',type=int,default=2)
    arguments = parser.parse_args()
    try:
        build_runtime(pathlib.Path(__file__).with_name('runtime-lock.json'),arguments.cache,arguments.output,arguments.jobs)
    except (BuildError,subprocess.SubprocessError,OSError,ValueError) as error:
        # Provider/public-client source and subprocess stderr are never copied into this message.
        code = str(error) if isinstance(error,BuildError) else type(error).__name__
        print('RUNTIME_BUILD_FAILED: '+code,file=sys.stderr)
        sys.exit(1)
