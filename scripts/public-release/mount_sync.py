#!/usr/bin/env python3
"""Root-only fixed-scope mount synchronizer; no generic command execution interface."""
from __future__ import annotations
import base64
import hashlib
import json
import os
import pathlib
import re
import socket
import stat
import sys
import time
import uuid

sys.dont_write_bytecode=True
from install import (APP,ETC,STATE,MEDIA,UNIT,UUID,current_release,managed_mount_units,marker,
    user_identity,verify_installed_files)
from lifecycle_lib import (InstallError,command,create_directory,ensure_stopped,installer_lock,
    require_directory,service_state)
from release_lib import BuildError,read_regular


def desired_mounts(value: dict) -> list[dict]:
    if not isinstance(value,dict) or set(value)!={'version','slots','desired'} or value['version']!=1: raise InstallError('MOUNT_REGISTRY_INVALID')
    slots=value['slots']; desired=value['desired']
    if not isinstance(slots,list) or len(slots)>512 or not isinstance(desired,dict) or set(desired)!={'enabled','accounts','cacheMaxBytes','reserveBytes'}: raise InstallError('MOUNT_REGISTRY_INVALID')
    indexes={}; used=set()
    for item in slots:
        if not isinstance(item,dict) or set(item)!={'accountId','slot'} or not isinstance(item['accountId'],str) or not re.fullmatch(UUID,item['accountId']) or type(item['slot']) is not int or not 0<=item['slot']<=511 or item['accountId'] in indexes or item['slot'] in used: raise InstallError('MOUNT_REGISTRY_INVALID')
        indexes[item['accountId']]=item['slot']; used.add(item['slot'])
    accounts=desired['accounts']
    if type(desired['enabled']) is not bool or not isinstance(accounts,list) or len(accounts)>512 or any(type(desired[key]) is not int or not 0<=desired[key]<=2**53-1 for key in ['cacheMaxBytes','reserveBytes']): raise InstallError('MOUNT_REGISTRY_INVALID')
    if not desired['enabled']:
        if accounts: raise InstallError('MOUNT_REGISTRY_INVALID')
        return []
    ids=set(); result=[]
    for item in accounts:
        if not isinstance(item,dict) or set(item)!={'id','cryptRemote'} or item['id'] not in indexes or item['id'] in ids or not isinstance(item['cryptRemote'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}:',item['cryptRemote']): raise InstallError('MOUNT_REGISTRY_INVALID')
        ids.add(item['id']); slot=indexes[item['id']]
        for kind,offset in [('media',0),('imports',1)]:
            result.append({'accountId':item['id'],'kind':kind,'remote':item['cryptRemote'],'port':34800+2*slot+offset,
                'cacheBytes':max(1,desired['cacheMaxBytes']//len(accounts)) if kind=='media' else 0,'reserveBytes':desired['reserveBytes']})
    return result


def owned_write(filename: pathlib.Path, data: bytes, mode=0o600) -> bool:
    if filename.exists() or filename.is_symlink():
        info=filename.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode & 0o077: raise InstallError('MOUNT_CONFIG_UNSAFE')
        if read_regular(filename)==data: return False
    temporary=filename.with_name('.'+filename.name+'-'+uuid.uuid4().hex)
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
    os.replace(temporary,filename)
    return True


def fuse_allow_other():
    filename=pathlib.Path('/etc/fuse.conf')
    info=filename.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode & 0o022: raise InstallError('FUSE_CONFIG_UNSAFE')
    content=read_regular(filename,65536)
    if any(line.split('#',1)[0].strip()=='user_allow_other' for line in content.decode('utf8').splitlines()): return
    # Preserve every previous byte; append only the standard option needed by a
    # different Jellyfin UID. Uninstall does not remove shared FUSE policy.
    fd=os.open(filename,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW)
    with os.fdopen(fd,'wb') as output:
        current=os.fstat(output.fileno())
        if (current.st_dev,current.st_ino,current.st_size)!=(info.st_dev,info.st_ino,info.st_size): raise InstallError('FUSE_CONFIG_CHANGED')
        output.write(b'\n# PTVault public: read-only cloud media for Jellyfin\nuser_allow_other\n'); output.flush(); os.fsync(output.fileno())


def sync():
    if os.geteuid()!=0 or len(sys.argv)!=1: raise InstallError('ROOT_ONLY_FIXED_ARGUMENTS')
    require_directory(ETC,owner=0,private=True)
    with installer_lock(ETC):
        if marker()['phase']!='INSTALLED' or service_state(UNIT).get('ActiveState')!='active': return
        release=current_release(); verify_installed_files(release)
        account=user_identity(); require_directory(STATE,owner=account.pw_uid,private=True)
        filename=STATE/'setup/mounts.json'
        if not filename.exists(): return
        info=filename.lstat()
        if info.st_uid!=account.pw_uid or info.st_mode & 0o077: raise InstallError('MOUNT_REGISTRY_UNSAFE')
        desired=desired_mounts(json.loads(read_regular(filename)))
        existing=managed_mount_units()
        names={f"ptvault-public-{entry['kind']}@{entry['accountId']}.service" for entry in desired}
        for name in set(existing)-names:
            command(['systemctl','disable','--now',name],timeout=100); ensure_stopped(name)
        if not desired: return
        fuse_allow_other()
        create_directory(ETC/'mounts',0o700)
        create_directory(STATE/'media-cache',0o700,account.pw_uid,account.pw_gid)
        key=STATE/'setup/runtime-credentials/mount-rc.key'; info=key.lstat()
        if info.st_uid!=account.pw_uid or info.st_mode & 0o077: raise InstallError('MOUNT_CREDENTIAL_UNSAFE')
        password=read_regular(key,1024)
        if not re.fullmatch(rb'[A-Za-z0-9_-]{43}',password): raise InstallError('MOUNT_CREDENTIAL_INVALID')
        # SHA htpasswd is supported by rclone. The input is 256-bit random data,
        # not a human password; no public login or low-entropy password uses SHA-1.
        htpasswd=b'ptvault:{SHA}'+base64.b64encode(hashlib.sha1(password).digest())+b'\n'
        credential_changed=owned_write(ETC/'mount-rc.htpasswd',htpasswd)
        changed=0
        for entry in desired:
            kind,identifier=entry['kind'],entry['accountId']; name=f'ptvault-public-{kind}@{identifier}.service'
            mountpoint=MEDIA/'mounts'/kind/identifier
            # Check only the local mountpoint before mounting. A live FUSE root is
            # provider-controlled and must never be chmodded/chowned by this helper.
            status=service_state(name)
            if status.get('ActiveState') not in ('active','activating','deactivating'):
                create_directory(mountpoint,0o755,account.pw_uid,account.pw_gid)
            if kind=='media': create_directory(STATE/'media-cache'/identifier,0o700,account.pw_uid,account.pw_gid)
            data=(f"CRYPT_REMOTE={entry['remote']}\nRC_ADDR=127.0.0.1:{entry['port']}\nCACHE_MAX_BYTES={entry['cacheBytes']}\nMIN_FREE_BYTES={entry['reserveBytes']}\n").encode()
            env_file=ETC/'mounts'/f'{kind}-{identifier}.env'
            config_changed=owned_write(env_file,data)
            active=status.get('ActiveState')=='active'
            if active and not (config_changed or credential_changed): continue
            if status.get('ActiveState') in ('activating','deactivating'): continue
            # Do not defeat systemd's burst limit every 15 seconds. A persistent
            # failure gets a slow automatic retry, while changed settings retry now.
            if status.get('ActiveState')=='failed' and not (config_changed or credential_changed) and time.time()-env_file.stat().st_mtime<300: continue
            if not active:
                with socket.socket() as probe:
                    try: probe.bind(('127.0.0.1',entry['port']))
                    except OSError: raise InstallError('MOUNT_PORT_IN_USE') from None
            if active: command(['systemctl','restart',name],timeout=110)
            else:
                command(['systemctl','reset-failed',name],check=False)
                command(['systemctl','enable',name])
                command(['systemctl','start','--no-block',name])
            os.utime(env_file,None,follow_symlinks=False)
            changed+=1
        if changed: print(json.dumps({'status':'MOUNT_UNITS_REQUESTED','changed':changed,'desired':len(desired)}))


if __name__=='__main__':
    try: sync()
    except InstallError as error:
        if str(error)=='INSTALLER_BUSY': sys.exit(0)
        print('PUBLIC_MOUNT_SYNC_FAILED: '+str(error),file=sys.stderr); sys.exit(1)
    except (BuildError,OSError,ValueError,KeyError,TypeError):
        print('PUBLIC_MOUNT_SYNC_FAILED: INVALID_LOCAL_STATE',file=sys.stderr); sys.exit(1)
