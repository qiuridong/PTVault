#!/usr/bin/env python3
"""PTVault public installer: only its own account, paths and systemd units are managed."""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import pathlib
import pwd
import re
import shutil
import socket
import sys
import uuid

sys.dont_write_bytecode=True

from lifecycle_lib import (InstallError, assert_platform, assert_root_systemd, atomic_private_json, check_master_key,
    command, create_directory, create_master_key, database_idle, ensure_stopped,
    installer_lock, operator_lease, read_root_json, require_directory, service_state,
    state_backup, verify_release, wait_healthy)
from release_lib import BuildError, read_regular, sha256_file

APP=pathlib.Path('/opt/ptvault-public')
ETC=pathlib.Path('/etc/ptvault-public')
STATE=pathlib.Path('/var/lib/ptvault-public')
MEDIA=pathlib.Path('/srv/ptvault-public')
BACKUPS=pathlib.Path('/var/backups/ptvault-public')
UNIT='ptvault-public.service'
UNIT_ROOT=pathlib.Path('/etc/systemd/system')
MARKER=ETC/'installer.json'
WRAPPER=pathlib.Path('/usr/local/bin/ptvault')
WRAPPER_TEXT=b'#!/bin/sh\nset -eu\nexec /usr/bin/python3 -B /opt/ptvault-public/current/scripts/public-release/install.py "$@"\n'
UUID=r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'


def marker() -> dict:
    require_directory(ETC,owner=0,private=True)
    value=read_root_json(MARKER)
    if value.get('schemaVersion')!=1 or value.get('product')!='PTVault-public' or value.get('phase') not in ('PREPARING','INSTALLED','UNINSTALLED','UPGRADING','RECOVERY_REQUIRED'):
        raise InstallError('INSTALLATION_MARKER')
    return value


def save_marker(value: dict): atomic_private_json(MARKER,value)


def current_release() -> pathlib.Path:
    require_directory(APP,owner=0)
    link=APP/'current'
    if not link.is_symlink(): raise InstallError('CURRENT_RELEASE_MISSING')
    target=link.resolve(strict=True)
    if target.parent!=APP/'releases': raise InstallError('CURRENT_RELEASE_UNSAFE')
    require_directory(target,owner=0)
    return target


def switch_release(target: pathlib.Path):
    if target.parent!=APP/'releases': raise InstallError('CURRENT_RELEASE_UNSAFE')
    link=APP/('.current-'+uuid.uuid4().hex)
    link.symlink_to('releases/'+target.name)
    os.replace(link,APP/'current')
    fd=os.open(APP,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def user_identity():
    account=pwd.getpwnam('ptvault-public')
    if account.pw_uid==0 or account.pw_dir!=str(STATE) or account.pw_shell!='/usr/sbin/nologin': raise InstallError('SERVICE_USER_CONFLICT')
    return account


def prepare_media_directories(account):
    create_directory(STATE/'media-cache',0o700,account.pw_uid,account.pw_gid)
    create_directory(MEDIA/'hot',0o700,account.pw_uid,account.pw_gid)


def run_cli(release: pathlib.Path, action: str, extra=(), *, display=False):
    # --pipe attaches private terminal pipes rather than sending setup URLs to journald.
    args=['systemd-run','--quiet','--wait','--pipe','--collect','--service-type=exec',
          '--unit=ptvault-public-command-'+uuid.uuid4().hex,
          '--property=User=ptvault-public','--property=Group=ptvault-public',
          '--property=UMask=0077','--property=LoadCredential=master.key:'+str(ETC/'master.key'),
          '--property=WorkingDirectory='+str(STATE),
          release/'runtime/node/bin/node',release/'apps/api/dist/cli/public.js',action,
          '--release-root',release,*extra]
    return command(args,capture=not display,timeout=120)


def managed_mount_units() -> list[str]:
    output=command(['systemctl','list-units','--all','--plain','--no-legend','--type=service',
                    'ptvault-public-media@*.service','ptvault-public-imports@*.service'])
    units=[]
    for line in output.splitlines():
        name=line.split()[0]
        if not re.fullmatch(r'ptvault-public-(media|imports)@'+UUID+r'\.service',name): raise InstallError('MOUNT_UNIT_UNEXPECTED')
        units.append(name)
    return sorted(set(units))


def unit_sources(release: pathlib.Path) -> dict[pathlib.Path,pathlib.Path]:
    templates=release/'scripts/public-release/templates'
    allowed={'ptvault-public.service','ptvault-public-export.service','ptvault-public-media@.service','ptvault-public-imports@.service','ptvault-public-mount-sync.service','ptvault-public-mount-sync.timer'}
    names=[name for name in templates.iterdir() if name.suffix in ('.service','.timer')]
    if any(name.name not in allowed for name in names): raise InstallError('RELEASE_UNIT_NAME')
    return {UNIT_ROOT/name.name:name for name in names}


def verify_installed_files(old: pathlib.Path, *, uninstalled=False):
    for destination,source in unit_sources(old).items():
        if uninstalled and not destination.exists(): continue
        info=destination.lstat()
        if not destination.is_file() or destination.is_symlink() or info.st_uid!=0 or info.st_mode & 0o022 or read_regular(destination)!=read_regular(source): raise InstallError('LOCAL_UNIT_CHANGED')
        dropin=destination.with_name(destination.name+'.d')
        if dropin.exists() and any(dropin.iterdir()): raise InstallError('LOCAL_UNIT_DROPIN')
    if uninstalled and not WRAPPER.exists(): return
    if WRAPPER.is_symlink() or read_regular(WRAPPER)!=WRAPPER_TEXT or WRAPPER.stat().st_uid!=0: raise InstallError('LOCAL_WRAPPER_CHANGED')


def install_files(release: pathlib.Path):
    for destination,source in unit_sources(release).items():
        data=read_regular(source)
        temporary=destination.with_name('.'+destination.name+'-'+uuid.uuid4().hex)
        with temporary.open('xb') as output: output.write(data)
        temporary.chmod(0o644); os.replace(temporary,destination)
    temporary=WRAPPER.with_name('.ptvault-'+uuid.uuid4().hex)
    with temporary.open('xb') as output: output.write(WRAPPER_TEXT)
    temporary.chmod(0o755); os.replace(temporary,WRAPPER)
    command(['systemctl','daemon-reload'])


def retire_added_units(old: pathlib.Path, candidate: pathlib.Path):
    old_files=unit_sources(old)
    for destination,source in unit_sources(candidate).items():
        if destination in old_files or not destination.exists(): continue
        if destination.is_symlink() or read_regular(destination)!=read_regular(source): raise InstallError('NEW_UNIT_CHANGED_DURING_UPGRADE')
        if service_state(destination.name).get('LoadState')=='loaded':
            command(['systemctl','stop',destination.name],timeout=110)
            ensure_stopped(destination.name)
            command(['systemctl','disable',destination.name])
        destination.unlink()
    command(['systemctl','daemon-reload'])


def ensure_service_stopped_for_operation():
    status=service_state(UNIT)
    if status.get('ActiveState') in ('active','activating'):
        pid=int(status.get('MainPID','0'))
        if pid<=0: raise InstallError('SERVICE_NOT_READY')
        with operator_lease(STATE,pid) as probe:
            probe()  # The connection holds admission shut until graceful shutdown owns it.
            command(['systemctl','stop',UNIT],timeout=620)
    elif status.get('ActiveState') not in ('inactive','failed'): raise InstallError('SERVICE_TRANSITIONING')
    ensure_stopped(UNIT)
    if status.get('ActiveState')=='active':
        ended=service_state(UNIT)
        if ended.get('ExecMainStatus')!='0' or ended.get('Result')!='success': raise InstallError('SERVICE_STOP_NOT_GRACEFUL')


def stop_mounts() -> list[str]:
    # These names are exclusively this installer's templates; never touch other rclone units.
    units=managed_mount_units()
    for name in units:
        command(['systemctl','stop',name],timeout=90)
        ensure_stopped(name)
    return units


def pause_mount_sync():
    timer='ptvault-public-mount-sync.timer'; sync='ptvault-public-mount-sync.service'
    if service_state(timer).get('LoadState')=='loaded': command(['systemctl','stop',timer])
    if service_state(sync).get('LoadState')=='loaded':
        command(['systemctl','stop',sync],timeout=90); ensure_stopped(sync)


def start_components():
    if service_state('ptvault-public-export.service').get('LoadState')=='loaded': command(['systemctl','enable','--now','ptvault-public-export.service'])
    command(['systemctl','enable','--now',UNIT])
    installation=json.loads(read_regular(STATE/'installation.json'))
    wait_healthy(installation['port'])
    timer='ptvault-public-mount-sync.timer'
    if service_state(timer).get('LoadState')=='loaded': command(['systemctl','enable','--now',timer])


def stage(source: pathlib.Path, manifest: dict) -> pathlib.Path:
    digest=sha256_file(source/'RELEASE_MANIFEST.json')
    name=manifest['version']+'-'+digest[:12]
    target=APP/'releases'/name
    if target.exists():
        if sha256_file(target/'RELEASE_MANIFEST.json')!=digest or verify_release(target)!=manifest: raise InstallError('RELEASE_ALREADY_CHANGED')
        require_directory(target,owner=0); return target
    temporary=APP/'releases'/('.staging-'+uuid.uuid4().hex)
    shutil.copytree(source,temporary,symlinks=True)
    if sha256_file(temporary/'RELEASE_MANIFEST.json')!=digest or verify_release(temporary)!=manifest: raise InstallError('SOURCE_CHANGED_DURING_COPY')
    for item in [temporary,*temporary.rglob('*')]:
        if item.is_symlink(): os.lchown(item,0,0)
        else:
            os.chown(item,0,0)
            item.chmod(0o755 if item.is_dir() or item.stat().st_mode & 0o111 else 0o644)
    os.rename(temporary,target)
    verify_release(target)
    return target


def first_install(source: pathlib.Path, manifest: dict, port: int):
    for directory in [APP,STATE,MEDIA,BACKUPS]:
        if directory.exists() or directory.is_symlink(): raise InstallError('INSTALL_PATH_ALREADY_EXISTS')
    if any(UNIT_ROOT.glob('ptvault-public*')) or WRAPPER.exists() or WRAPPER.is_symlink(): raise InstallError('INSTALL_NAME_CONFLICT')
    try: pwd.getpwnam('ptvault-public')
    except KeyError: pass
    else: raise InstallError('SERVICE_USER_CONFLICT')
    with socket.socket() as probe:
        try: probe.bind(('127.0.0.1',port))
        except OSError: raise InstallError('PORT_IN_USE') from None
    save_marker({'schemaVersion':1,'product':'PTVault-public','phase':'PREPARING','requestedPort':port})
    finish_first_install(source,manifest,port)


def finish_first_install(source: pathlib.Path, manifest: dict, port: int):
    # A persisted PREPARING marker permits resuming only this exact new installation.
    create_directory(APP,0o755); create_directory(APP/'releases',0o755)
    create_directory(BACKUPS,0o700)
    try: account=user_identity()
    except KeyError:
        command(['useradd','--system','--user-group','--home-dir',STATE,'--no-create-home','--shell','/usr/sbin/nologin','ptvault-public'])
        account=user_identity()
    create_directory(STATE,0o700,account.pw_uid,account.pw_gid)
    create_directory(MEDIA,0o755)
    for name in ['library','mounts']:
        create_directory(MEDIA/name,0o755,account.pw_uid,account.pw_gid)
    for name in ['media','imports']:
        create_directory(MEDIA/'mounts'/name,0o755,account.pw_uid,account.pw_gid)
    create_master_key(ETC/'master.key',STATE)
    target=stage(source,manifest)
    run_cli(target,'init',['--port',str(port)])
    # init must see an empty new state directory. Populate optional runtime
    # directories only after its installation marker is safely persisted.
    prepare_media_directories(account)
    switch_release(target); install_files(target)
    start_components()
    save_marker({'schemaVersion':1,'product':'PTVault-public','phase':'INSTALLED','current':target.name,'port':port})
    print('安装完成。只监听本机回环地址；未修改防火墙、Nginx、Docker、qB 或 Jellyfin。')
    print('使用 sudo ptvault setup-link 获取首次初始化链接；不要把该链接贴入日志或公开分享。')


def upgrade(source: pathlib.Path, manifest: dict, existing: dict):
    old=current_release(); verify_release(old)
    uninstalled=existing['phase']=='UNINSTALLED'
    verify_installed_files(old,uninstalled=uninstalled)
    check_master_key(ETC/'master.key'); account=user_identity()
    require_directory(STATE,owner=account.pw_uid,private=True)
    target=stage(source,manifest)
    for destination in set(unit_sources(target))-set(unit_sources(old)):
        if destination.exists() or destination.is_symlink(): raise InstallError('NEW_UNIT_NAME_CONFLICT')
    if target==old and existing['phase']=='INSTALLED':
        print('此发行版本已经安装；未停止服务、未改密钥、数据库或初始化链接。')
        print('查看状态：sudo ptvault status；检查安装：sudo ptvault doctor。')
        return
    was_active=service_state(UNIT).get('ActiveState')=='active'
    # Gate before stopping ANY component. Busy refusal is a no-op for running work.
    ensure_service_stopped_for_operation()
    stopped_mounts=[]
    try:
        pause_mount_sync(); stopped_mounts=stop_mounts()
        database_idle(STATE)
        prepare_media_directories(account)
        backup=state_backup(STATE,ETC,BACKUPS,old)
        save_marker({**existing,'phase':'UPGRADING','previous':old.name,'candidate':target.name,'backup':backup.name})
        switch_release(target); install_files(target)
        start_components()
        save_marker({'schemaVersion':1,'product':'PTVault-public','phase':'INSTALLED','current':target.name,'port':existing['port'],'backup':backup.name})
        print('发行版已切换并通过本机健康检查；原密钥、数据库、账号、设置与暂存目录保留。')
        print('控制面备份：'+str(backup)+'（不含大体积暂存/媒体，它们原位保留）。')
    except Exception:
        # Code-only rollback is allowed only after an independently idle, stopped check.
        # Never restore a database or old token snapshot over newer state.
        try:
            ensure_service_stopped_for_operation(); pause_mount_sync(); stop_mounts(); database_idle(STATE)
            retire_added_units(old,target)
            switch_release(old); install_files(old)
            if was_active: start_components()
            for name in stopped_mounts:
                if was_active: command(['systemctl','start',name],timeout=90)
            save_marker({**existing,'phase':'INSTALLED' if was_active else existing['phase'],'lastUpgradeFailed':True})
        except Exception:
            save_marker({**existing,'phase':'RECOVERY_REQUIRED','candidate':target.name})
            raise InstallError('UPGRADE_RECOVERY_REQUIRED') from None
        raise InstallError('UPGRADE_FAILED_OLD_CODE_RESTORED') from None


def uninstall(existing: dict):
    if existing['phase']=='UNINSTALLED':
        print('本安装已经卸载；原数据与恢复资料保持，未重复备份或删除。'); return
    old=current_release(); verify_installed_files(old,uninstalled=existing['phase']=='UNINSTALLED')
    was_active=service_state(UNIT).get('ActiveState')=='active'
    ensure_service_stopped_for_operation()
    units=[]
    try:
        pause_mount_sync(); units=stop_mounts(); database_idle(STATE)
        backup=state_backup(STATE,ETC,BACKUPS,old)
        if service_state('ptvault-public-export.service').get('LoadState')=='loaded':
            command(['systemctl','stop','ptvault-public-export.service']); ensure_stopped('ptvault-public-export.service')
        for name in [UNIT,'ptvault-public-mount-sync.timer','ptvault-public-export.service',*units]:
            if service_state(name).get('LoadState')=='loaded': command(['systemctl','disable',name])
        for destination in unit_sources(old):
            if destination.exists(): destination.unlink()
        if WRAPPER.exists(): WRAPPER.unlink()
        command(['systemctl','daemon-reload'])
        save_marker({**existing,'phase':'UNINSTALLED','backup':backup.name})
    except Exception:
        try:
            database_idle(STATE); install_files(old)
            if was_active: start_components()
            for name in units:
                if was_active: command(['systemctl','start',name],timeout=110)
        except Exception:
            save_marker({**existing,'phase':'RECOVERY_REQUIRED'})
            raise InstallError('UNINSTALL_RECOVERY_REQUIRED') from None
        raise InstallError('UNINSTALL_FAILED_OLD_SERVICE_RESTORED') from None
    print('已停止本安装的服务/挂载并移除系统入口。未删密钥、数据库、账号、设置、暂存或媒体。')
    print('发行文件和专用服务账号也保留，便于原位重装；再次运行发行包安装入口可恢复。')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['install','upgrade','uninstall','status','doctor','setup-link'])
    parser.add_argument('--release',type=pathlib.Path)
    parser.add_argument('--port',type=int)
    parser.add_argument('--no-install-deps',action='store_true',help='Do not install missing Ubuntu FUSE dependencies')
    args=parser.parse_args()
    if args.port is not None and not 1024<=args.port<=65535: raise InstallError('PORT_RANGE')
    assert_root_systemd()
    os.umask(0o077)
    if args.action in ('install','upgrade'):
        if args.release is None: raise InstallError('RELEASE_REQUIRED')
        source=args.release.resolve(strict=True); manifest=verify_release(source)
        assert_platform(install_dependencies=not args.no_install_deps)
    elif args.release is not None or args.port is not None: raise InstallError('ARGUMENT_INVALID')
    if not ETC.exists():
        if args.action!='install': raise InstallError('NOT_INSTALLED')
        create_directory(ETC,0o700)
    require_directory(ETC,owner=0,private=True)
    with installer_lock(ETC):
        if not MARKER.exists():
            if args.action!='install': raise InstallError('NOT_INSTALLED')
            if set(p.name for p in ETC.iterdir())!={'installer.lock'}: raise InstallError('EXISTING_CONFIG_NOT_ADOPTED')
            first_install(source,manifest,args.port or 3210); return
        existing=marker()
        if args.port is not None and args.port!=existing.get('port',existing.get('requestedPort')): raise InstallError('PORT_MISMATCH')
        if existing['phase']=='RECOVERY_REQUIRED' and args.action in ('install','upgrade','uninstall'): raise InstallError('RECOVERY_REQUIRES_INSPECTION')
        if args.action in ('install','upgrade'):
            if existing['phase']=='PREPARING':
                finish_first_install(source,manifest,existing['requestedPort'])
            else:
                # Run the selected release's manager only after copying and verifying
                # its full payload in a root-owned tree. Never exec from a mutable
                # download directory; the kernel closes the non-inheritable lock fd.
                target=stage(source,manifest)
                entry=target/'scripts/public-release/install.py'
                if pathlib.Path(__file__).resolve()!=entry:
                    argv=['python3','-B',str(entry),args.action,'--release',str(target)]
                    if args.port is not None: argv+=['--port',str(args.port)]
                    if args.no_install_deps: argv+=['--no-install-deps']
                    os.execve('/usr/bin/python3',argv,{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8'})
                upgrade(source,manifest,existing)
        elif args.action in ('doctor','setup-link'):
            run_cli(current_release(),args.action,display=True)
        elif args.action=='status':
            state=service_state(UNIT)
            counts={}
            for name in managed_mount_units():
                status=service_state(name).get('ActiveState','unknown'); counts[status]=counts.get(status,0)+1
            print(json.dumps({'phase':existing['phase'],'version':existing.get('current'),'service':state.get('ActiveState'),'pid':state.get('MainPID'),'port':existing.get('port'),'mountStates':counts},ensure_ascii=False,indent=2))
        elif args.action=='uninstall': uninstall(existing)


if __name__=='__main__':
    try: main()
    except (InstallError,BuildError,OSError,ValueError,KeyError) as error:
        code=str(error) if isinstance(error,(InstallError,BuildError)) else type(error).__name__
        print('安装操作未完成：'+code+'。现有数据不会自动重置；请保留失败目录和原安装资料。',file=sys.stderr)
        sys.exit(1)
