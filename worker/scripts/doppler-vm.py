#!/usr/bin/env python3
"""Fixed offline VM entry point: bounded page-range chunks, ordered Markdown merge.

No URLs, credentials, user flags or host paths. The host supplies a single PDF
and, for a parallel shard, an optional page range; all page counting, range
validation, parsing and merging happen behind the VM boundary.
"""
import ctypes
import json
import os
import re
import resource
import stat
import struct
import subprocess
import sys
import time
from pathlib import Path

DOPPLER_GUEST_PROTOCOL = "doppler-vm@4"
MAX_SHARD_REQUEST = 256
MAX_INPUT = 500 * 1024 * 1024
MAX_RAW = 256 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
# One VM converts at most MAX_PAGES pages. A longer document is converted only as host-planned
# shards, each of at most MAX_PAGES pages, up to MAX_DOCUMENT_PAGES in total.
MAX_PAGES = 10000
MAX_DOCUMENT_PAGES = 100000
CHUNK_PAGES = 32
JOB_SECONDS = 150


# ---- defense in depth inside the VM (the VM is the boundary) ----
# Landlock confines the parser to read/execute system paths and read/write /job; seccomp refuses kernel
# attack surface a PDF parser never needs. Both apply to this process and every child. Failure to apply
# either refuses the job: the guest never runs an untrusted parse with weaker confinement than declared.
LANDLOCK_MIN_ABI = 4
_FS_EXECUTE, _FS_WRITE_FILE, _FS_READ_FILE, _FS_READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
_FS_REMOVE_DIR, _FS_REMOVE_FILE, _FS_MAKE_CHAR, _FS_MAKE_DIR = 1 << 4, 1 << 5, 1 << 6, 1 << 7
_FS_MAKE_REG, _FS_MAKE_SOCK, _FS_MAKE_FIFO, _FS_MAKE_BLOCK = 1 << 8, 1 << 9, 1 << 10, 1 << 11
_FS_MAKE_SYM, _FS_REFER, _FS_TRUNCATE, _FS_IOCTL_DEV = 1 << 12, 1 << 13, 1 << 14, 1 << 15
_NET_BIND_TCP, _NET_CONNECT_TCP = 1 << 0, 1 << 1
_SCOPE_ABSTRACT_UNIX, _SCOPE_SIGNAL = 1 << 0, 1 << 1
_SYS_CREATE_RULESET, _SYS_ADD_RULE, _SYS_RESTRICT_SELF = 444, 445, 446  # x86-64 and the generic table
# No /proc: a parser child must not reach the guest's descriptors (/proc/<pid>/fd) or other processes' state.
READ_ONLY_PATHS = ('/usr', '/lib', '/lib64', '/bin', '/etc', '/opt/doppler', '/opt/docslurp', '/var/cache/fontconfig')
HARDENING_POLICY = 'doppler-guest-hardening@2'
SECCOMP_DENY = (
    'ptrace', 'process_vm_readv', 'process_vm_writev', 'mount', 'umount2', 'pivot_root', 'chroot', 'move_mount',
    'open_tree', 'fsopen', 'fsconfig', 'fsmount', 'fspick', 'mount_setattr', 'unshare', 'setns', 'bpf',
    'perf_event_open', 'userfaultfd', 'keyctl', 'add_key', 'request_key', 'kexec_load', 'kexec_file_load',
    'init_module', 'finit_module', 'delete_module', 'io_uring_setup', 'io_uring_enter', 'io_uring_register',
    'open_by_handle_at', 'name_to_handle_at', 'socket', 'socketpair', 'swapon', 'swapoff', 'reboot', 'acct',
    'quotactl', 'syslog', 'settimeofday', 'clock_settime', 'adjtimex', 'fanotify_init', 'lookup_dcookie', 'vhangup',
    # Metadata outside Landlock's content rules: modes, owners, xattrs, timestamps.
    'chmod', 'fchmod', 'fchmodat', 'fchmodat2', 'chown', 'fchown', 'lchown', 'fchownat', 'setxattr', 'lsetxattr',
    'fsetxattr', 'removexattr', 'lremovexattr', 'fremovexattr', 'setxattrat', 'removexattrat', 'utime', 'utimes',
    'futimesat', 'utimensat',
    # Anonymous executables, SysV IPC and cross-process control.
    'memfd_create', 'execveat', 'shmget', 'shmat', 'shmdt', 'shmctl', 'msgget', 'msgsnd', 'msgrcv', 'msgctl',
    'semget', 'semop', 'semtimedop', 'semctl', 'process_madvise', 'pidfd_open', 'pidfd_getfd', 'pidfd_send_signal', 'kcmp',
)
# clone3 cannot be filtered by flag (its flags live in memory): ENOSYS makes glibc fall back to clone, where the
# namespace flags are refused below.
CLONE_NAMESPACE_FLAGS = (0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000)


def _landlock(libc, job):
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(_SYS_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    if abi < LANDLOCK_MIN_ABI:
        raise ValueError('landlock unavailable')
    handled = (1 << 13) - 1 | _FS_REFER | _FS_TRUNCATE | (_FS_IOCTL_DEV if abi >= 5 else 0)
    fields = [('fs', ctypes.c_uint64), ('net', ctypes.c_uint64)] + ([('scoped', ctypes.c_uint64)] if abi >= 6 else [])
    attr = type('RulesetAttr', (ctypes.Structure,), {'_fields_': fields})()
    attr.fs = handled
    attr.net = _NET_BIND_TCP | _NET_CONNECT_TCP  # no TCP rules: every bind and connect is refused
    if abi >= 6:
        attr.scoped = _SCOPE_ABSTRACT_UNIX | _SCOPE_SIGNAL
    ruleset = libc.syscall(_SYS_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0))
    if ruleset < 0:
        raise ValueError('landlock ruleset refused')
    try:
        def allow(path, access):
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                # struct landlock_path_beneath_attr is packed: u64 allowed_access, s32 parent_fd.
                rule = ctypes.create_string_buffer(struct.pack('=Qi', access & handled, fd), 12)
                if libc.syscall(_SYS_ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(1), rule, ctypes.c_uint32(0)) != 0:
                    raise ValueError('landlock rule refused')
            finally:
                os.close(fd)
        for path in READ_ONLY_PATHS:
            if os.path.isdir(path):
                allow(path, _FS_EXECUTE | _FS_READ_FILE | _FS_READ_DIR)
        allow(job, _FS_READ_FILE | _FS_READ_DIR | _FS_WRITE_FILE | _FS_MAKE_REG | _FS_REMOVE_FILE | _FS_TRUNCATE)
        allow('/dev/null', _FS_READ_FILE | _FS_WRITE_FILE)
        if libc.syscall(_SYS_RESTRICT_SELF, ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:
            raise ValueError('landlock restrict refused')
    finally:
        os.close(ruleset)
    return abi


def _seccomp():
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise ValueError('seccomp unavailable')
    try:
        def resolve(name):
            nr = lib.seccomp_syscall_resolve_name(name.encode())
            if nr < 0:
                raise ValueError('seccomp syscall unknown')  # every listed call is mandatory: never silently skipped
            return nr
        denied = 0
        for name in SECCOMP_DENY:
            if lib.seccomp_rule_add(ctx, 0x00050000 | 1, resolve(name), 0) != 0:  # SCMP_ACT_ERRNO(EPERM)
                raise ValueError('seccomp rule refused')
            denied += 1
        if lib.seccomp_rule_add(ctx, 0x00050000 | 38, resolve('clone3'), 0) != 0:  # SCMP_ACT_ERRNO(ENOSYS)
            raise ValueError('seccomp rule refused')
        clone = resolve('clone')
        for flag in CLONE_NAMESPACE_FLAGS:
            # struct scmp_arg_cmp {unsigned arg; enum op; u64 datum_a; u64 datum_b}: (arg0 & flag) == flag
            cmp = ctypes.create_string_buffer(struct.pack('<IIQQ', 0, 7, flag, flag), 24)  # SCMP_CMP_MASKED_EQ = 7
            if lib.seccomp_rule_add_array(ctx, 0x00050000 | 1, clone, 1, cmp) != 0:
                raise ValueError('seccomp rule refused')
        if lib.seccomp_load(ctx) != 0:
            raise ValueError('seccomp load refused')
    finally:
        lib.seccomp_release(ctx)
    return denied


class HardeningError(Exception):
    pass


def _status(field):
    with open('/proc/self/status') as status:
        for line in status:
            if line.startswith(field + ':'):
                return line.split(':', 1)[1].strip()
    raise HardeningError('process status unavailable')


def _drop_capabilities(libc):
    # The guest may run as root: drop every capability (ambient, bounding, then effective/permitted/inheritable).
    if int(_status('CapEff'), 16) or int(_status('CapPrm'), 16) or int(_status('CapBnd'), 16):
        libc.prctl(47, 4, 0, 0, 0)  # PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL (no-op when unsupported)
        for cap in range(64):
            if libc.prctl(24, cap, 0, 0, 0) != 0 and ctypes.get_errno() not in (22, 1):  # PR_CAPBSET_DROP; EINVAL ends, EPERM checked below
                raise HardeningError('capability drop refused')
        header = ctypes.create_string_buffer(struct.pack('=Ii', 0x20080522, 0), 8)  # _LINUX_CAPABILITY_VERSION_3
        data = ctypes.create_string_buffer(24)  # two zeroed {effective, permitted, inheritable}
        libc.syscall.restype = ctypes.c_long
        if libc.syscall(126, header, data) != 0:  # capset (x86-64)
            raise HardeningError('capset refused')
    if int(_status('CapEff'), 16) or int(_status('CapPrm'), 16):
        raise HardeningError('capabilities remain')
    return int(_status('CapBnd'), 16) == 0


def harden(job='/job'):
    libc = ctypes.CDLL(None, use_errno=True)
    # Landlock and seccomp bind the calling thread; the guest is single-threaded before any parse.
    if _status('Threads') != '1':
        raise HardeningError('guest is not single-threaded')
    bounding_cleared = _drop_capabilities(libc)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise ValueError('no_new_privs refused')
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE 0: no ptrace-mode access to the guest from its children
        raise ValueError('dumpable refused')
    abi = _landlock(libc, job)
    denied = _seccomp()
    return {'policy': HARDENING_POLICY, 'noNewPrivs': True, 'capabilities': 0, 'boundingCleared': bounding_cleared,
            'landlockAbi': abi, 'seccompDenied': denied}


def page_ranges(pages, first=1, last=None):
    if type(pages) is not int or not 1 <= pages <= MAX_DOCUMENT_PAGES:
        raise ValueError('invalid PDF page count')
    last = pages if last is None else last
    if type(first) is not int or type(last) is not int or not 1 <= first <= last <= pages or last - first + 1 > MAX_PAGES:
        raise ValueError('PDF range exceeds the per-VM page limit')
    return [(start, min(start + CHUNK_PAGES - 1, last)) for start in range(first, last + 1, CHUNK_PAGES)]


def shard_request(pages, path=Path('/job/shard.json')):
    """The host's page range for a parallel shard, or the whole document when absent.

    Ranges start on the internal chunk grid, so a shard runs exactly the chunks the
    whole-document conversion would and the merged output is byte-identical. A final
    shard must end on the document's last page: a host page count that is too low
    fails here instead of silently dropping pages.
    """
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return 1, pages
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SHARD_REQUEST:
        raise ValueError('invalid shard request')
    request = json.loads(path.read_bytes())
    if type(request) is not dict or set(request) != {'first', 'last', 'final'}:
        raise ValueError('invalid shard request')
    first, last, final = request['first'], request['last'], request['final']
    if type(first) is not int or type(last) is not int or type(final) is not bool:
        raise ValueError('invalid shard request')
    if not 1 <= first <= last <= pages or (first - 1) % CHUNK_PAGES:
        raise ValueError('shard range outside document or chunk grid')
    if final != (last == pages) or (not final and last % CHUNK_PAGES):
        raise ValueError('shard end does not match document')
    return first, last


def chunk_settings(settings, document_pages, chunk_pages):
    # A short tail must not turn a section label into repeated page furniture.
    # Require the same absolute repetition count as whole-document conversion.
    # Counts from other chunks are unavailable, so retaining extra furniture is
    # intentional; losing meaningful text is worse than retaining a header.
    params = json.loads(settings)
    params['furniture_min_share'] = params.get('furniture_min_share', 0.4) * document_pages / chunk_pages
    return json.dumps(params)


def append_chunk(output, chunk_path, expected_pages, first, total_bytes):
    # Binary form feeds retain exact page slots, including blank first/last pages.
    size = chunk_path.stat().st_size
    if size + total_bytes + (0 if first else 1) > MAX_OUTPUT:
        raise ValueError('Markdown exceeds limit')
    separators = 0
    if not first:
        output.write(b'\f')
        total_bytes += 1
    with chunk_path.open('rb') as chunk:
        while data := chunk.read(65536):
            separators += data.count(b'\f')
            total_bytes += len(data)
            if total_bytes > MAX_OUTPUT:
                raise ValueError('Markdown exceeds limit')
            output.write(data)
    if separators != expected_pages - 1:
        raise ValueError('chunk page slots do not match range')
    return total_bytes


def main():
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (JOB_SECONDS, JOB_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RAW,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        hardening = harden()
    except Exception as error:
        raise HardeningError('confinement unavailable') from error
    info = os.lstat('/job/input')
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT:
        raise ValueError('invalid PDF input')
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/job', 'TMPDIR': '/job', 'LANG': 'C.UTF-8'}
    started = time.monotonic()

    def run(args, stdout, stderr):
        remaining = JOB_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            raise ValueError('document deadline exceeded')
        subprocess.run(args, env=env, stdout=stdout, stderr=stderr, check=True, timeout=min(45, remaining))

    with open('/job/info', 'xb') as output, open('/job/parser.log', 'xb') as log:
        run(['/opt/doppler/bin/pdfinfo', '/job/input'], output, log)
    with open('/job/info', 'rb') as source:
        info_text = source.read(65537)
    if len(info_text) > 65536:
        raise ValueError('PDF info exceeds limit')
    match = re.search(rb'^Pages:\s+(\d+)\s*$', info_text, re.MULTILINE)
    pages = int(match[1]) if match else 0
    if type(pages) is not int or not 1 <= pages <= MAX_DOCUMENT_PAGES:
        raise ValueError('invalid PDF page count')  # validated before any request is read
    shard_first, shard_last = shard_request(pages)
    ranges = page_ranges(pages, shard_first, shard_last)
    settings = Path('/opt/doppler/defaults.json').read_text()
    total_bytes = 0
    words = 0
    degraded_pages = 0
    with open('/job/output', 'xb') as output:
        for index, (first, last) in enumerate(ranges):
            with open('/job/parser.log', 'wb') as log:
                run(['/opt/doppler/bin/pdftotext', '-bbox-layout', '-compact-layout', '-wordmeta', '-rules',
                     '-f', str(first), '-l', str(last), '-enc', 'UTF-8', '-eol', 'unix',
                     '/job/input', '/job/raw.xhtml'], log, log)
            if Path('/job/raw.xhtml').stat().st_size > MAX_RAW:
                raise ValueError('PDF chunk text layer exceeds limit')
            with open('/job/chunk.md', 'wb') as chunk, open('/job/converter-report.json', 'wb') as report:
                params = chunk_settings(settings, pages, last - first + 1)
                run(['/opt/doppler/bin/doppler-md', '--report', '--params', params, '/job/raw.xhtml'], chunk, report)
            with open('/job/converter-report.json', 'rb') as report:
                diagnostics = json.loads(report.read(16385))
            if type(diagnostics.get('pages')) is not int or diagnostics['pages'] != last - first + 1:
                raise ValueError('PDF chunk page count mismatch')
            total_bytes = append_chunk(output, Path('/job/chunk.md'), last - first + 1, index == 0, total_bytes)
            words += diagnostics.get('words', 0)
            degraded_pages += len(diagnostics.get('degraded', []))
            # Reuse bounded files; never accumulate intermediates per chunk.
            for name in ('raw.xhtml', 'chunk.md', 'converter-report.json'):
                Path('/job', name).unlink()
    print(json.dumps({'protocol': DOPPLER_GUEST_PROTOCOL, 'engine': 'doppler', 'hardening': hardening,
                      'elapsedMs': round((time.monotonic() - started) * 1000), 'outputBytes': total_bytes,
                      'conversion': {'pages': shard_last - shard_first + 1, 'first': shard_first, 'last': shard_last,
                                     'documentPages': pages, 'chunks': len(ranges), 'chunkPages': CHUNK_PAGES,
                                     'words': words, 'degradedPages': degraded_pages}}), file=sys.stderr)
    fd = os.open('/job/output', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != total_bytes:
            raise ValueError('invalid Markdown output')
        remaining = MAX_OUTPUT + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)


def entry():
    try:
        main()
    except HardeningError:
        # Distinct exit code: the host reports confinement failure, not a parse failure, and never retries weaker.
        print('Doppler guest confinement unavailable', file=sys.stderr)
        raise SystemExit(3)
    except Exception:
        raise SystemExit('Doppler guest refused or failed extraction')


if __name__ == '__main__':
    entry()
