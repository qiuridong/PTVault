"""Private Linux installer primitives. Never operate on an existing private PTVault service."""
from __future__ import annotations

import base64
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import time
import urllib.request
import uuid

from build_release import inventory, verify_tree
from release_lib import BuildError, read_regular, sha256_file


class InstallError(RuntimeError): pass


def command(args, *, capture=True, timeout=90, check=True):
    try:
        result=subprocess.run([str(value) for value in args],stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else None,stderr=subprocess.PIPE if capture else None,
            text=True,timeout=timeout,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8','DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_MODE':'l'})
    except subprocess.TimeoutExpired: raise InstallError('COMMAND_TIMED_OUT: '+pathlib.Path(str(args[0])).name) from None
    if check and result.returncode: raise InstallError('COMMAND_FAILED: '+pathlib.Path(str(args[0])).name)
    return result.stdout if check else result


def require_directory(directory: pathlib.Path, *, owner: int | None = None, private=False):
    if not directory.is_absolute(): raise InstallError('PATH_UNSAFE')
    for current in [directory,*directory.parents]:
        info=current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode): raise InstallError('PATH_UNSAFE')
    info=directory.lstat()
    if owner is not None and info.st_uid != owner: raise InstallError('PATH_OWNER')
    if info.st_mode & (0o077 if private else 0o022): raise InstallError('PATH_PERMISSIONS')


def create_directory(directory: pathlib.Path, mode: int, uid=0, gid=0):
    require_directory(directory.parent)
    try: directory.mkdir(mode=mode)
    except FileExistsError:
        require_directory(directory,owner=uid,private=mode==0o700)
        return
    os.chown(directory,uid,gid); directory.chmod(mode)


def atomic_private_json(filename: pathlib.Path, value: dict):
    if filename.exists() or filename.is_symlink():
        info=filename.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1: raise InstallError('MARKER_UNSAFE')
    temporary=filename.with_name('.'+filename.name+'-'+uuid.uuid4().hex)
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as output:
        json.dump(value,output,ensure_ascii=False,indent=2); output.write('\n'); output.flush(); os.fsync(output.fileno())
    os.replace(temporary,filename)
    fd=os.open(filename.parent,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def read_root_json(filename: pathlib.Path) -> dict:
    info=filename.lstat()
    if info.st_uid != 0 or info.st_mode & 0o077: raise InstallError('MARKER_UNSAFE')
    result=json.loads(read_regular(filename))
    if not isinstance(result,dict): raise InstallError('MARKER_UNSAFE')
    return result


def check_master_key(filename: pathlib.Path):
    info=filename.lstat()
    if info.st_uid != 0 or info.st_mode & 0o077: raise InstallError('KEY_UNSAFE')
    value=read_regular(filename,1024).strip()
    try: key=base64.b64decode(value,validate=True)
    except ValueError: raise InstallError('KEY_INVALID') from None
    if len(key)!=32 or base64.b64encode(key)!=value: raise InstallError('KEY_INVALID')


def create_master_key(filename: pathlib.Path, state: pathlib.Path):
    if filename.exists() or filename.is_symlink(): check_master_key(filename); return
    if (state/'installation.json').exists() or (state/'ptvault.db').exists(): raise InstallError('ORIGINAL_KEY_MISSING')
    fd=os.open(filename,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as output:
        output.write(base64.b64encode(os.urandom(32))+b'\n'); output.flush(); os.fsync(output.fileno())
    check_master_key(filename)


def verify_release(directory: pathlib.Path) -> dict:
    directory=directory.resolve(strict=True)
    manifest=json.loads(read_regular(directory/'RELEASE_MANIFEST.json'))
    if manifest.get('schemaVersion') != 1 or manifest.get('product') != 'PTVault-public' or manifest.get('platform') != 'linux-x64' or manifest.get('databaseSchema') != 42:
        raise InstallError('RELEASE_UNSUPPORTED')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?',manifest.get('version','')): raise InstallError('RELEASE_UNSUPPORTED')
    rows=manifest.get('files')
    if not isinstance(rows,list) or not 10<len(rows)<100000: raise InstallError('RELEASE_UNSUPPORTED')
    verify_tree(directory,rows)
    actual=inventory(directory)
    actual=[row for row in actual if row['path']!='RELEASE_MANIFEST.json']
    if actual!=rows: raise InstallError('RELEASE_UNLISTED_FILES')
    required=['apps/api/dist/cli/public.js','apps/web/dist/index.html','runtime/node/bin/node','runtime/archive/7zzs',
              'runtime/archive/probe/loader','runtime/archive/probe/ffprobe','runtime/archive/archive-sandbox.py',
              'scripts/public-release/install.py','scripts/public-release/templates/ptvault-public.service']
    if any(not (directory/name).is_file() for name in required): raise InstallError('RELEASE_INCOMPLETE')
    return manifest


def database_idle(state: pathlib.Path, *, missing_ok=False) -> dict:
    filename=state/'ptvault.db'
    if not filename.exists():
        if missing_ok: return {'schema':None,'tables':0}
        raise InstallError('DATABASE_MISSING')
    info=filename.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode & 0o077: raise InstallError('DATABASE_UNSAFE')
    # Only called after our service AND managed mounts have stopped. No live WAL takeover.
    with contextlib.closing(sqlite3.connect(filename.as_uri()+'?mode=ro',uri=True,timeout=5)) as db:
        if db.execute('PRAGMA quick_check').fetchone()!=('ok',): raise InstallError('DATABASE_CHECK')
        version=db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0]
        if version!=42: raise InstallError('DATABASE_SCHEMA')
        for sql in ["SELECT COUNT(*) FROM jobs WHERE state NOT IN ('COMPLETED','FAILED_SAFE','CANCELLED_SAFE')",
                    "SELECT COUNT(*) FROM import_jobs WHERE state NOT IN ('COMPLETED','FAILED_SAFE','CANCELLED_SAFE')",
                    "SELECT COUNT(*) FROM media_publications WHERE state='RUNNING'",
                    "SELECT COUNT(*) FROM source_cleanups WHERE status='RUNNING'"]:
            if db.execute(sql).fetchone()[0]: raise InstallError('ACTIVE_TASKS')
        return {'schema':version,'tables':db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]}


def state_backup(state: pathlib.Path, etc: pathlib.Path, backups: pathlib.Path, release: pathlib.Path) -> pathlib.Path:
    database_idle(state)
    output=backups/(time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+uuid.uuid4().hex[:8])
    output.mkdir(mode=0o700)
    # Do not copy huge spools or follow user/source/media symlinks. All remain in place.
    excluded={'spool','media-cache','control.sock','ptvault.db','ptvault.db-wal','ptvault.db-shm'}
    for src in sorted(state.iterdir()):
        name=src.name
        if name in excluded: continue
        if src.is_symlink(): raise InstallError('BACKUP_PATH_UNSAFE')
        if src.is_dir():
            for item in src.rglob('*'):
                if item.is_symlink() or not (item.is_file() or item.is_dir()): raise InstallError('BACKUP_PATH_UNSAFE')
            shutil.copytree(src,output/name)
        else: shutil.copy2(src,output/name)
    with contextlib.closing(sqlite3.connect((state/'ptvault.db').as_uri()+'?mode=ro',uri=True)) as src, contextlib.closing(sqlite3.connect(output/'ptvault.db')) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA quick_check').fetchone()!=('ok',): raise InstallError('BACKUP_DATABASE')
    shutil.copytree(etc,output/'etc',ignore=shutil.ignore_patterns('installer.lock'))
    for item in output.rglob('*'):
        if item.is_file(): item.chmod(0o600)
        elif item.is_dir(): item.chmod(0o700)
    atomic_private_json(output/'BACKUP.json',{'schemaVersion':1,'kind':'CONTROL_PLANE_ONLY','release':release.name,
        'databaseSchema':42,'spoolCopied':False,'mediaCopied':False,'files':[
        {'path':item.relative_to(output).as_posix(),'bytes':item.stat().st_size,'sha256':sha256_file(item)} for item in sorted(output.rglob('*')) if item.is_file()]})
    return output


@contextlib.contextmanager
def operator_lease(state: pathlib.Path, expected_pid: int):
    filename=state/'control.sock'; info=filename.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_mode & 0o077: raise InstallError('CONTROL_UNAVAILABLE')
    client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); client.settimeout(5)
    try:
        client.connect(str(filename))
        def request(op):
            client.sendall((json.dumps({'op':op})+'\n').encode()); data=b''
            while not data.endswith(b'\n'):
                part=client.recv(1024)
                if not part or len(data)+len(part)>2048: raise InstallError('CONTROL_UNAVAILABLE')
                data+=part
            status=json.loads(data)
            if status.get('ok') is not True or status.get('pid')!=expected_pid or status.get('idle') is not True: raise InstallError('ACTIVE_TASKS_OR_HANDLERS')
            return status
        request('prepare')
        yield lambda: request('probe')
    finally: client.close() # Disconnect releases admission unless shutdown already began.


def assert_root_systemd():
    if os.geteuid()!=0: raise InstallError('ROOT_REQUIRED')
    if os.uname().machine!='x86_64': raise InstallError('LINUX_X64_REQUIRED')
    if pathlib.Path('/proc/1/comm').read_text().strip()!='systemd': raise InstallError('SYSTEMD_REQUIRED')


def assert_platform(*, install_dependencies=True):
    assert_root_systemd()
    release=dict(line.split('=',1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if release.get('ID','').strip('"')!='ubuntu' or release.get('VERSION_ID','').strip('"')!='24.04': raise InstallError('UBUNTU_24_04_REQUIRED')
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.syscall(444,0,0,1)<4: raise InstallError('LANDLOCK_ABI_4_REQUIRED')
    if not pathlib.Path('/usr/bin/fusermount3').is_file():
        if not install_dependencies: raise InstallError('INSTALL_FUSE3_REQUIRED')
        print('正在安装所需的 Ubuntu fuse3 依赖；不会安装或修改 Docker、Nginx、qB 或 Jellyfin。',flush=True)
        command(['/usr/bin/apt-get','update'],capture=False,timeout=300)
        command(['/usr/bin/apt-get','install','-y','--no-remove','--no-install-recommends','fuse3'],capture=False,timeout=300)
    if not pathlib.Path('/dev/fuse').exists() and install_dependencies:
        command(['/usr/sbin/modprobe','fuse'])
    if not pathlib.Path('/dev/fuse').exists() or not stat.S_ISCHR(pathlib.Path('/dev/fuse').stat().st_mode): raise InstallError('FUSE_DEVICE_UNAVAILABLE')


def service_state(unit: str) -> dict:
    output=command(['systemctl','show',unit,'-p','LoadState','-p','ActiveState','-p','SubState','-p','MainPID','-p','ControlGroup','-p','Result','-p','ExecMainCode','-p','ExecMainStatus'])
    return dict(line.split('=',1) for line in output.splitlines() if '=' in line)


def ensure_stopped(unit: str):
    status=service_state(unit)
    if status.get('ActiveState') not in ('inactive','failed') or status.get('MainPID')!='0': raise InstallError('SERVICE_NOT_STOPPED')
    group=status.get('ControlGroup')
    if group and (pathlib.Path('/sys/fs/cgroup')/group.lstrip('/')).exists():
        for item in (pathlib.Path('/sys/fs/cgroup')/group.lstrip('/')).rglob('cgroup.procs'):
            if item.read_text().strip(): raise InstallError('SERVICE_CHILDREN_REMAIN')


def wait_healthy(port: int):
    for _ in range(60):
        if service_state('ptvault-public.service').get('ActiveState')=='active':
            try:
                with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/health',timeout=2) as response:
                    if response.status==200 and json.load(response).get('status')=='ok': return
            except (OSError,ValueError): pass
        time.sleep(0.5)
    raise InstallError('NEW_SERVICE_UNHEALTHY')


@contextlib.contextmanager
def installer_lock(etc: pathlib.Path):
    fd=os.open(etc/'installer.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1: raise InstallError('INSTALL_LOCK_UNSAFE')
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise InstallError('INSTALLER_BUSY') from None
        yield
    finally: os.close(fd)
