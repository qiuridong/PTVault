#!/usr/bin/env python3
"""Own one shared bind mount so new cloud submounts reach read-only container binds."""
from __future__ import annotations
import json
import os
import pathlib
import sys
sys.dont_write_bytecode=True
from lifecycle_lib import InstallError,atomic_private_json,command,read_root_json,require_directory

ROOT=pathlib.Path('/srv/ptvault-public')
RECORD=pathlib.Path('/etc/ptvault-public/export-root.json')


def mount_rows():
    rows=[]
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        fields=line.split(); delimiter=fields.index('-')
        if fields[4]==str(ROOT) or fields[4].startswith(str(ROOT)+'/'):
            rows.append({'id':int(fields[0]),'path':fields[4],'shared':any(value.startswith('shared:') for value in fields[6:delimiter])})
    return rows


def own(row):
    value=read_root_json(RECORD); info=ROOT.stat()
    return value.get('version')==1 and value.get('mountId')==row['id'] and value.get('bootId')==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() and value.get('dev')==info.st_dev and value.get('ino')==info.st_ino and row['shared']


def main(action):
    if os.geteuid()!=0: raise InstallError('ROOT_REQUIRED')
    require_directory(ROOT,owner=0)
    require_directory(RECORD.parent,owner=0,private=True)
    rows=mount_rows(); exact=[row for row in rows if row['path']==str(ROOT)]
    if len(exact)>1: raise InstallError('EXPORT_MOUNT_AMBIGUOUS')
    if exact:
        if not RECORD.exists() or not own(exact[0]): raise InstallError('EXPORT_MOUNT_NOT_OWNED')
        if action=='start': return
        if len(rows)!=1: raise InstallError('EXPORT_CHILD_MOUNTS_ACTIVE')
        command(['/usr/bin/umount',ROOT])
        if mount_rows(): raise InstallError('EXPORT_UNMOUNT_NOT_CONFIRMED')
        return
    if action=='stop': return
    if rows: raise InstallError('EXPORT_CHILD_MOUNTS_ALREADY_EXIST')
    command(['/usr/bin/mount','--bind',ROOT,ROOT])
    try:
        command(['/usr/bin/mount','--make-rshared',ROOT])
        exact=[row for row in mount_rows() if row['path']==str(ROOT)]
        if len(exact)!=1 or not exact[0]['shared']: raise InstallError('EXPORT_PROPAGATION_FAILED')
        info=ROOT.stat()
        atomic_private_json(RECORD,{'version':1,'mountId':exact[0]['id'],'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'dev':info.st_dev,'ino':info.st_ino})
    except Exception:
        # Only this newly-created exact bind, without recursive/lazy unmounting.
        if len(mount_rows())==1: command(['/usr/bin/umount',ROOT],check=False)
        raise


if __name__=='__main__':
    try:
        if len(sys.argv)!=2 or sys.argv[1] not in ('start','stop'): raise InstallError('FIXED_ARGUMENT_REQUIRED')
        main(sys.argv[1])
    except (InstallError,OSError,ValueError,KeyError):
        print('PUBLIC_EXPORT_ROOT_OPERATION_FAILED',file=sys.stderr); sys.exit(1)
