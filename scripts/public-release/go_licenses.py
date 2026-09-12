"""Collect age dependency notices from the exact go.sum-bound module contents."""
from __future__ import annotations
import base64
import hashlib
import json
import pathlib
import re
import tarfile
import zipfile

from release_lib import BuildError,fetch_https,relative_name,sha256_file


def module_hash(archive: pathlib.Path, prefix: str) -> str:
    summary=hashlib.sha256(); seen=set(); total=0
    with zipfile.ZipFile(archive) as source:
        for item in sorted(source.infolist(),key=lambda row:row.filename):
            name=item.filename
            if name in seen or '\n' in name or not name.startswith(prefix+'/') or relative_name(name).rstrip('/')!=name.rstrip('/'): raise BuildError('GO_MODULE_ENTRY')
            seen.add(name); total+=item.file_size
            if len(seen)>100000 or total>256*1024*1024: raise BuildError('GO_MODULE_LIMIT')
            digest=hashlib.sha256()
            with source.open(item) as stream:
                while chunk:=stream.read(1024*1024): digest.update(chunk)
            summary.update((digest.hexdigest()+'  '+name+'\n').encode('utf8'))
    return 'h1:'+base64.b64encode(summary.digest()).decode('ascii')


def collect_age_dependencies(built: pathlib.Path, runtime: dict, release: pathlib.Path, sources: pathlib.Path):
    entry=runtime['inputs']['ageSource']; source=built/'third-party-sources'/entry['file']
    if sha256_file(source)!=entry['sha256']: raise BuildError('AGE_SOURCE_CHANGED')
    with tarfile.open(source,'r:*') as archive:
        text={}
        for name in ['go.mod','go.sum']:
            matches=[item for item in archive.getmembers() if item.isfile() and item.name.count('/')==1 and item.name.endswith('/'+name)]
            if len(matches)!=1 or matches[0].size>1024*1024: raise BuildError('AGE_MODULE_METADATA')
            text[name]=archive.extractfile(matches[0]).read().decode('utf8')
    block=re.search(r'require\s*\((.*?)\)',text['go.mod'],re.S)
    if not block: raise BuildError('AGE_MODULE_METADATA')
    dependencies=[]
    for line in block.group(1).splitlines():
        values=line.strip().split()
        if not values: continue
        if len(values)!=2 or not re.fullmatch(r'[a-z0-9][a-z0-9./-]+',values[0]) or not re.fullmatch(r'v[0-9][A-Za-z0-9.+-]*',values[1]): raise BuildError('AGE_MODULE_METADATA')
        dependencies.append(values)
    checksums={tuple(values[:2]):values[2] for line in text['go.sum'].splitlines() if len(values:=line.split())==3}
    sources.mkdir(); records=[]
    for module,version in dependencies:
        expected=checksums.get((module,version))
        if not expected or not expected.startswith('h1:'): raise BuildError('AGE_MODULE_CHECKSUM')
        url=f'https://proxy.golang.org/{module}/@v/{version}.zip'
        destination=sources/(module.replace('/','_')+'@'+version+'.zip')
        total=0
        with fetch_https(url) as response, destination.open('xb') as output:
            while chunk:=response.read(1024*1024):
                total+=len(chunk)
                if total>64*1024*1024: raise BuildError('GO_MODULE_DOWNLOAD_LIMIT')
                output.write(chunk)
        prefix=module+'@'+version
        if module_hash(destination,prefix)!=expected: raise BuildError('GO_MODULE_HASH')
        licenses=[]
        with zipfile.ZipFile(destination) as archive:
            for item in archive.infolist():
                if item.is_dir() or not re.match(r'^(license|licence|copying|notice|patents)(\.|$)',pathlib.PurePosixPath(item.filename).name,re.I): continue
                if item.file_size>2*1024*1024: raise BuildError('GO_LICENSE_LIMIT')
                name=relative_name(item.filename); target=release/'licenses/age-dependencies'/name
                target.parent.mkdir(parents=True,exist_ok=True)
                with target.open('xb') as output: output.write(archive.read(item))
                licenses.append(target.relative_to(release).as_posix())
        if not licenses: raise BuildError('GO_LICENSE_MISSING')
        records.append({'module':module,'version':version,'source':url,'goSum':expected,'zipSha256':sha256_file(destination),'licenseFiles':licenses})
    (release/'GO_COMPONENTS.json').write_text(json.dumps(records,indent=2)+'\n')
