#!/usr/bin/env python3
"""Fixed offline VM entry point: bounded page-range chunks, ordered Markdown merge.

No URLs, credentials, user flags or host paths. The host supplies a single PDF
and, for a parallel shard, an optional page range; all page counting, range
validation, parsing and merging happen behind the VM boundary.
"""
import ctypes
import hashlib
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

DOPPLER_GUEST_PROTOCOL = "doppler-vm@5"
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
# x86-64 numbers (Linux uapi asm/unistd_64.h) for every filtered call: an older libseccomp that does not know a
# newer name still gets the rule by number, and a known name must agree with this table.
X86_64_SYSCALLS = {
    'shmget': 29, 'shmat': 30, 'shmctl': 31, 'socket': 41, 'socketpair': 53, 'clone': 56, 'semget': 64,
    'semop': 65, 'semctl': 66, 'shmdt': 67, 'msgget': 68, 'msgsnd': 69, 'msgrcv': 70, 'msgctl': 71, 'chmod': 90,
    'fchmod': 91, 'chown': 92, 'fchown': 93, 'lchown': 94, 'ptrace': 101, 'syslog': 103, 'utime': 132,
    'vhangup': 153, 'pivot_root': 155, 'adjtimex': 159, 'chroot': 161, 'acct': 163, 'settimeofday': 164,
    'mount': 165, 'umount2': 166, 'swapon': 167, 'swapoff': 168, 'reboot': 169, 'init_module': 175,
    'delete_module': 176, 'quotactl': 179, 'setxattr': 188, 'lsetxattr': 189, 'fsetxattr': 190, 'removexattr': 197,
    'lremovexattr': 198, 'fremovexattr': 199, 'lookup_dcookie': 212, 'semtimedop': 220, 'clock_settime': 227,
    'utimes': 235, 'kexec_load': 246, 'add_key': 248, 'request_key': 249, 'keyctl': 250, 'fchownat': 260,
    'futimesat': 261, 'fchmodat': 268, 'unshare': 272, 'utimensat': 280, 'perf_event_open': 298,
    'fanotify_init': 300, 'name_to_handle_at': 303, 'open_by_handle_at': 304, 'setns': 308,
    'process_vm_readv': 310, 'process_vm_writev': 311, 'kcmp': 312, 'finit_module': 313, 'memfd_create': 319,
    'kexec_file_load': 320, 'bpf': 321, 'execveat': 322, 'userfaultfd': 323, 'pidfd_send_signal': 424,
    'io_uring_setup': 425, 'io_uring_enter': 426, 'io_uring_register': 427, 'open_tree': 428, 'move_mount': 429,
    'fsopen': 430, 'fsconfig': 431, 'fsmount': 432, 'fspick': 433, 'pidfd_open': 434, 'clone3': 435,
    'pidfd_getfd': 438, 'process_madvise': 440, 'mount_setattr': 442, 'fchmodat2': 452, 'setxattrat': 463,
    'removexattrat': 466,
}
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
        x86_64 = os.uname().machine == 'x86_64'
        def resolve(name):
            nr = lib.seccomp_syscall_resolve_name(name.encode())
            pinned = X86_64_SYSCALLS.get(name) if x86_64 else None
            if nr < 0:
                nr = pinned if pinned is not None else -1
            elif pinned is not None and nr != pinned:
                raise ValueError(f'seccomp syscall number mismatch: {name}')
            if nr < 0:
                raise ValueError(f'seccomp syscall unknown: {name}')  # every listed call is mandatory: never skipped
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
            cmp = ctypes.create_string_buffer(struct.pack('=IIQQ', 0, 7, flag, flag), 24)  # SCMP_CMP_MASKED_EQ = 7
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
    # Always clear: ambient, bounding (needs CAP_SETPCAP; EPERM when not root), then all three sets via capset.
    libc.prctl(47, 4, 0, 0, 0)  # PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL (no-op when unsupported)
    for cap in range(64):
        if libc.prctl(24, cap, 0, 0, 0) != 0 and ctypes.get_errno() not in (22, 1):  # PR_CAPBSET_DROP; EINVAL ends
            raise HardeningError('capability drop refused')
    header = ctypes.create_string_buffer(struct.pack('=Ii', 0x20080522, 0), 8)  # _LINUX_CAPABILITY_VERSION_3
    data = ctypes.create_string_buffer(24)  # two zeroed {effective, permitted, inheritable}
    libc.syscall.restype = ctypes.c_long
    if libc.syscall(126, header, data) != 0:  # capset (x86-64)
        raise HardeningError('capset refused')
    if any(int(_status(field), 16) for field in ('CapEff', 'CapPrm', 'CapInh', 'CapAmb')):
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


# Image extraction is an explicit option in the same Markdown VM. Page previews and vector
# drawings are not embedded raster assets. Masks stay attached to their source occurrence.
MAX_IMAGE_OCCURRENCES = 512
MAX_IMAGE_PIXELS = 16_000_000
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024


def image_inventory(listing, pages, first=1, last=None):
    last = pages if last is None else last
    rows = []
    pixels = 0
    for line in listing.splitlines():
        fields = line.split()
        if not fields or not fields[0].isdigit():
            continue
        if len(fields) < 14:
            raise ValueError('invalid image inventory')
        page, number, kind, width, height = int(fields[0]), int(fields[1]), fields[2], int(fields[3]), int(fields[4])
        if not first <= page <= last or number != len(rows) or kind not in ('image', 'mask', 'smask', 'stencil') or width < 1 or height < 1:
            raise ValueError('invalid image inventory')
        pixels += width * height
        if pixels > MAX_IMAGE_PIXELS or len(rows) >= MAX_IMAGE_OCCURRENCES:
            raise ValueError('image geometry exceeds limit')
        row = {'pageNumber': page, 'occurrence': number, 'role': kind, 'width': width, 'height': height}
        if kind in ('mask', 'smask'):
            if not rows or rows[-1]['role'] != 'image' or rows[-1]['pageNumber'] != page:
                raise ValueError('unassociated image mask')
            row['maskOf'] = rows[-1]['occurrence']
        rows.append(row)
    return rows


def webp_dimensions(data):
    # The fixed encoder emits simple lossless WebP. Reject other containers, not a full decoder.
    if (len(data) < 25 or data[:4] != b'RIFF' or data[8:16] != b'WEBPVP8L'
            or struct.unpack('<I', data[4:8])[0] + 8 != len(data)
            or 20 + ((struct.unpack('<I', data[16:20])[0] + 1) & ~1) != len(data)
            or data[20] != 0x2f or data[24] & 0xe0):
        raise ValueError('unsupported WebP container')
    bits = struct.unpack('<I', data[21:25])[0]
    return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1


def selected_image_occurrences(rows, min_width, min_height):
    if any(type(value) is not int or not 1 <= value <= 4096 for value in (min_width, min_height)):
        raise ValueError('invalid image dimensions')
    keep = {row['occurrence'] for row in rows if row['role'] in ('image', 'stencil') and row['width'] >= min_width and row['height'] >= min_height}
    keep.update(row['occurrence'] for row in rows if row.get('maskOf') in keep)
    return keep


def extract_image_bundle(run, pages, job=Path('/job'), binary='/opt/doppler/bin/pdfimages', first=1, last=None, encoder='/usr/bin/cwebp', min_width=1, min_height=1):
    last = pages if last is None else last
    if not 1 <= first <= last <= pages or last - first + 1 > MAX_PAGES:
        raise ValueError('image extraction page limit exceeded')
    with (job / 'image-list').open('xb') as listing, (job / 'image-log').open('xb') as log:
        run([binary, '-list', '-f', str(first), '-l', str(last), str(job / 'input')], listing, log)
    with (job / 'image-list').open('rb') as listing:
        data = listing.read(128 * 1024 + 1)
    if len(data) > 128 * 1024:
        raise ValueError('image inventory exceeds limit')
    rows = image_inventory(data.decode('ascii'), pages, first, last)
    keep = selected_image_occurrences(rows, min_width, min_height)
    if not keep:
        rows = []
    if rows:
        with (job / 'image-log').open('wb') as log:
            run([binary, '-png', '-p', '-f', str(first), '-l', str(last), str(job / 'input'), str(job / 'embedded')], log, log)
    assets = {}
    total = 0
    encoded = {}
    for row in rows:
        name = f"embedded-{row['pageNumber']:03d}-{row['occurrence']:03d}.png"
        path = job / name
        if row['occurrence'] not in keep:
            path.unlink()
            continue
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or not 24 <= info.st_size <= MAX_IMAGE_BYTES:
                raise ValueError('invalid extracted image')
            chunks = []
            size = 0
            while chunk := os.read(fd, min(65536, MAX_IMAGE_BYTES + 1 - size)):
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise ValueError('image exceeds limit')
            data = b''.join(chunks)
        finally:
            os.close(fd)
        total += len(data)
        if total > MAX_IMAGE_TOTAL_BYTES:
            raise ValueError('image bytes exceed limit')
        if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR' or struct.unpack('>II', data[16:24]) != (row['width'], row['height']):
            raise ValueError('image dimensions do not match inventory')
        png_hash = hashlib.sha256(data).digest()
        if png_hash in encoded:
            data = encoded[png_hash]
        else:
            # Lossless encoding preserves the decoded pixels, including unused RGB under alpha.
            webp_path = path.with_suffix('.webp')
            with (job / 'image-log').open('wb') as log:
                run([encoder, '-quiet', '-lossless', '-exact', str(path), '-o', str(webp_path)], log, log)
            fd = os.open(webp_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or not 25 <= info.st_size <= MAX_IMAGE_BYTES:
                    raise ValueError('invalid WebP output')
                data = os.read(fd, MAX_IMAGE_BYTES + 1)
            finally:
                os.close(fd)
            if len(data) != info.st_size or webp_dimensions(data) != (row['width'], row['height']):
                raise ValueError('WebP dimensions do not match inventory')
            webp_path.unlink()
            encoded[png_hash] = data
        digest = hashlib.sha256(data).hexdigest()
        assets.setdefault(digest, {'sha256': digest, 'width': row['width'], 'height': row['height'],
                                   'mediaType': 'image/webp', 'bytes': data})
        row['sha256'] = digest
        path.unlink()
    # No parser-chosen filenames are transferred. Unexpected files mean extraction and inventory disagree.
    if any(job.glob('embedded-*')):
        raise ValueError('unexpected extracted image')
    return {'pageCount': pages, 'first': first, 'last': last, 'minWidth': min_width, 'minHeight': min_height,
            'assets': list(assets.values()), 'placements': [row for row in rows if row['occurrence'] in keep]}


def image_frame_header(bundle, markdown_bytes):
    header = json.dumps({'version': 'doppler-images@1', 'pageCount': bundle['pageCount'],
                         'first': bundle['first'], 'last': bundle['last'], 'markdownBytes': markdown_bytes,
                         'minWidth': bundle['minWidth'], 'minHeight': bundle['minHeight'],
                         'assets': [{**{k: v for k, v in a.items() if k != 'bytes'}, 'length': len(a['bytes'])}
                                    for a in bundle['assets']], 'placements': bundle['placements']}, separators=(',', ':')).encode()
    wire_bytes = 12 + len(header) + markdown_bytes + sum(len(a['bytes']) for a in bundle['assets'])
    if len(header) > 256 * 1024 or wire_bytes > MAX_OUTPUT:
        raise ValueError('image frame exceeds limit')
    return b'DOPIMG1\n' + struct.pack('>I', len(header)) + header, wire_bytes


def image_options(args):
    if args == []:
        return False, 1, 1
    if args == ['--images']:
        return True, 1, 1
    if len(args) != 5 or args[0] != '--images' or args[1] != '--min-image-width' or args[3] != '--min-image-height':
        raise ValueError('invalid operation')
    values = []
    for value in (args[2], args[4]):
        if not re.fullmatch(r'[1-9][0-9]{0,3}', value) or not 1 <= int(value) <= 4096:
            raise ValueError('invalid image dimensions')
        values.append(int(value))
    return True, values[0], values[1]


def orientation_main():
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        hardening = harden()
    except Exception as error:
        raise HardeningError('confinement unavailable') from error
    info = os.lstat('/job/input')
    if not stat.S_ISREG(info.st_mode) or info.st_size > 32 * 1024 * 1024:
        raise ValueError('invalid orientation input')
    # -I excludes script directory; load only this immutable, image-baked module.
    import importlib.util
    spec = importlib.util.spec_from_file_location('image_orientation', '/opt/docslurp/image_orientation.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    started = time.monotonic()
    # Native runtime discovery may warn about intentionally blocked /proc and /sys.
    # Keep stdout/stderr exclusively for the bounded transport and JSON envelope.
    saved_out, saved_err = os.dup(1), os.dup(2)
    try:
        with open('/job/orientation-runtime.log', 'xb') as log:
            os.dup2(log.fileno(), 1)
            os.dup2(log.fileno(), 2)
            result = module.normalize('/job/input', '/job/oriented.png')
    finally:
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
    size = Path('/job/oriented.png').stat().st_size
    print(json.dumps({'protocol': DOPPLER_GUEST_PROTOCOL, 'engine':'orientation', 'hardening':hardening,
                      'outputBytes':size, 'runtimeLogBytes':Path('/job/orientation-runtime.log').stat().st_size, 'elapsedMs':round((time.monotonic()-started)*1000), 'orientation':result}), file=sys.stderr)
    with open('/job/oriented.png','rb') as output:
        while data := output.read(65536):
            sys.stdout.buffer.write(data)


def main():
    if sys.argv[1:] == ['--orientation']:
        return orientation_main()
    images_requested, min_width, min_height = image_options(sys.argv[1:])
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
                run(['/opt/doppler/bin/doppler-md', '--html', '--report', '--params', params, '/job/raw.xhtml'], chunk, report)
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
    image_bundle = None
    frame_header = b''
    wire_bytes = total_bytes
    if images_requested:
        # Same input, confinement and absolute deadline; no second VM/upload. Limit each decoded file.
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_IMAGE_BYTES,) * 2)
        image_bundle = extract_image_bundle(run, pages, first=shard_first, last=shard_last, min_width=min_width, min_height=min_height)
        frame_header, wire_bytes = image_frame_header(image_bundle, total_bytes)
    print(json.dumps({'protocol': DOPPLER_GUEST_PROTOCOL, 'engine': 'doppler', 'hardening': hardening,
                      'embeddedImages': images_requested, 'wireBytes': wire_bytes,
                      'elapsedMs': round((time.monotonic() - started) * 1000), 'outputBytes': total_bytes,
                      'conversion': {'pages': shard_last - shard_first + 1, 'first': shard_first, 'last': shard_last,
                                     'documentPages': pages, 'chunks': len(ranges), 'chunkPages': CHUNK_PAGES,
                                     'words': words, 'degradedPages': degraded_pages}}), file=sys.stderr)
    fd = os.open('/job/output', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != total_bytes:
            raise ValueError('invalid Markdown output')
        sys.stdout.buffer.write(frame_header)
        remaining = MAX_OUTPUT + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
        if image_bundle:
            for asset in image_bundle['assets']:
                sys.stdout.buffer.write(asset['bytes'])
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
