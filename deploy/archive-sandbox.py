#!/usr/bin/env python3
"""Launch only the fixed 7-Zip decoder with a least-privilege Landlock policy.

Passwords pass through stdin, untouched. This helper never prints arguments or
native diagnostics itself. Requires Linux Landlock ABI >= 4; no fallback to an
unrestricted decoder. No root, user namespace, firewall or service mutation.
"""
import argparse
import ctypes
import errno
import os
import platform
import resource
import stat
import sys


def fail():
    print('ARCHIVE_SANDBOX_UNAVAILABLE', file=sys.stderr)
    raise SystemExit(126)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output')
    parser.add_argument('--probe-runtime')
    parser.add_argument('--probe-file')
    parser.add_argument('--max-file-bytes', default='1099511627776')
    parser.add_argument('args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.args[1:] if args.args[:1] == ['--'] else args.args
    probe = args.probe_runtime is not None
    if probe:
        if command or args.output or not args.probe_file:
            fail()
        runtime = args.probe_runtime
        if not os.path.isabs(runtime) or os.path.realpath(runtime) != runtime or os.stat(runtime).st_mode & 0o022:
            fail()
        if args.binary != runtime + '/loader' or os.path.realpath(args.probe_file) != args.probe_file or not args.probe_file.startswith(args.input + '/'):
            fail()
        info = os.stat(args.probe_file)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail()
        command = ['--library-path', runtime + '/lib', runtime + '/ffprobe',
                   '-v', 'error', '-protocol_whitelist', 'file', '-probesize', '10000000',
                   '-analyzeduration', '10000000', '-show_entries',
                   'stream=codec_type,codec_name,width,height:stream_disposition=attached_pic',
                   '-of', 'json', '-i', args.probe_file]
    elif not command or command[0] not in ('l', 'x'):
        fail()
    for value in [args.binary, args.input, *([args.output] if args.output else [])]:
        if not os.path.isabs(value) or os.path.islink(value) or os.path.realpath(value) != value:
            fail()
    binary_info = os.stat(args.binary)
    if not stat.S_ISREG(binary_info.st_mode) or binary_info.st_mode & 0o022:
        fail()
    if not os.path.isdir(args.input) or (args.output and not os.path.isdir(args.output)):
        fail()
    if args.output and (args.output == args.input or args.output.startswith(args.input + '/')):
        fail()
    max_file = int(args.max_file_bytes)
    if max_file < 0 or max_file > 1024**5:
        fail()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # These syscall numbers are shared by the supported x86-64/arm64 Linux ABIs.
    if platform.machine() not in ('x86_64', 'aarch64'):
        fail()
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 4:
        fail()

    class Ruleset(ctypes.Structure):
        _fields_ = [('fs', ctypes.c_uint64), ('net', ctypes.c_uint64)]

    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [('access', ctypes.c_uint64), ('parent', ctypes.c_int32)]

    rule = Ruleset((1 << 15) - 1, 3)  # ABI3 fs rights plus ABI4 TCP deny-by-default.
    fd = libc.syscall(444, ctypes.byref(rule), ctypes.sizeof(rule), 0)
    if fd < 0:
        fail()
    def allow(filename, access):
        handle = os.open(filename, os.O_PATH | os.O_CLOEXEC)
        try:
            entry = PathRule(access, handle)
            if libc.syscall(445, fd, 1, ctypes.byref(entry), 0) != 0:
                fail()
        finally:
            os.close(handle)
    allow(args.binary, (1 << 0) | (1 << 2))
    if probe:
        allow(args.probe_runtime, (1 << 0) | (1 << 2) | (1 << 3))
        allow(args.probe_file, 1 << 2)
    else:
        allow(args.input, (1 << 2) | (1 << 3))
    if args.output:
        allow(args.output, sum(1 << bit for bit in [1, 2, 3, 4, 5, 7, 8, 13, 14]))
    allow('/dev/null', (1 << 1) | (1 << 2))
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        fail()
    if libc.syscall(446, fd, 0) != 0:
        fail()
    os.close(fd)

    # Landlock ABI4 handles TCP, not UDP. Deny socket creation altogether; also
    # block process inspection and signals to unrelated application processes.
    machine = platform.machine()
    denied = [41, 53, 57, 58, 101, 310, 311, 62, 200, 425] if machine == 'x86_64' else [198, 199, 117, 270, 271, 129, 130, 425]
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    audit_arch = 0xc000003e if machine == 'x86_64' else 0xc00000b7
    instructions = [
        Filter(0x20, 0, 0, 4),  # seccomp_data.arch: no compat-ABI escape.
        Filter(0x15, 1, 0, audit_arch), Filter(0x06, 0, 0, 0x80000000),
        Filter(0x20, 0, 0, 0),
    ]
    if machine == 'x86_64':
        instructions += [Filter(0x45, 0, 1, 0x40000000), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
    for number in denied:
        instructions += [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
    # glibc falls back from clone3/ENOSYS to clone. Only decoder threads may be
    # created: a compromised codec gets no process-fork primitive.
    instructions += [Filter(0x15, 0, 1, 435), Filter(0x06, 0, 0, 0x00050000 | errno.ENOSYS)]
    clone = 56 if machine == 'x86_64' else 220
    instructions += [Filter(0x15, 0, 4, clone), Filter(0x20, 0, 0, 16),
                     Filter(0x45, 1, 0, 0x10000), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM),
                     Filter(0x20, 0, 0, 0)]
    tgkill = 234 if machine == 'x86_64' else 131
    instructions += [
        Filter(0x15, 0, 3, tgkill), Filter(0x20, 0, 0, 16),
        Filter(0x15, 1, 0, os.getpid()), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM),
        Filter(0x06, 0, 0, 0x7fff0000),
    ]
    filters = (Filter * len(instructions))(*instructions)
    program = Program(len(instructions), filters)
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:  # PR_SET_SECCOMP/FILTER
        fail()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (6 * 60 * 60, 6 * 60 * 60))
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_file, max_file))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    os.execve(args.binary, [args.binary, *command], {'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'})


try:
    main()
except (OSError, ValueError, OverflowError):
    fail()
