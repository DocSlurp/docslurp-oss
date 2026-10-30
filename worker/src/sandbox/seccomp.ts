import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Classic-BPF seccomp filters, generated here (no libseccomp), that bwrap installs for every
 * sandboxed command (`--seccomp FD`). Every other system call is allowed.
 *
 * Every bubblewrap command gets the `base` profile:
 * - io_uring_setup, io_uring_enter and io_uring_register fail with ENOSYS. io_uring runs operations
 *   in kernel context that a syscall filter never sees: IORING_OP_SOCKET creates a socket (any
 *   family) without calling socket(), so a default-allow filter cannot restrict sockets while
 *   io_uring is open. No parser needs it; liburing callers fall back to plain syscalls.
 * - A system call from a foreign ABI (x32, or 32-bit compat: socketcall, a second io_uring numbering)
 *   kills the process: it could reach these calls under numbers the filter does not check.
 * - Namespaces and kernel attack surface, close to Docker's default profile, fail with EPERM:
 *   unshare, setns, and clone with any CLONE_NEW* flag (a nested user namespace grants
 *   CAP_NET_ADMIN over a new network namespace, and with it nf_tables); the mount API (mount,
 *   umount2, pivot_root, open_tree, move_mount, fsopen, fsconfig, fsmount, fspick, mount_setattr);
 *   bpf, perf_event_open, userfaultfd, keyctl, add_key, request_key, process_vm_readv/writev,
 *   open_by_handle_at, kexec, module loading, reboot, swapon/swapoff and acct. clone3 fails with
 *   ENOSYS: its flags live in memory a filter cannot read, and libc then falls back to clone(),
 *   whose flags it can. No parser needs any of these; fork, threads and posix_spawn keep working.
 *
 * Commands that never need a UNIX socket get the `deny-unix-sockets` profile: `base` plus
 * socket(AF_UNIX, ...) and socketpair(AF_UNIX, ...) failing with EAFNOSUPPORT. Two commands that
 * share a directory could otherwise meet on a socket file and pass file descriptors (SCM_RIGHTS),
 * for example one holding another's stdout open so that its teardown cannot be verified, which
 * quarantines the worker. Under bubblewrap each command has its own network namespace, so abstract
 * sockets are private already. Which commands may use one is decided in tools/runner.ts
 * (UNIX_SOCKET_CLIENTS).
 *
 * What this does not cover, and why that is acceptable here:
 * - An AF_UNIX descriptor inherited from the launcher: the worker gives a command pipes for stdio and
 *   bwrap closes the filter's descriptor, so a sandboxed command starts with none.
 * - Another process's descriptors (pidfd_getfd, ptrace, /proc/<pid>/fd): each command has its own
 *   PID namespace and /proc, so it can only reach its own processes.
 * - Opening a socket file with open(): the kernel refuses it (ENXIO); connect() needs a socket.
 */

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_RET_K = 0x06;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const BPF_JSET_K = 0x45;
const EPERM = 1;
const ENOSYS = 38;
const EAFNOSUPPORT = 97;
const AF_UNIX = 1;

/** seccomp_data offsets: nr, arch, args[0] (low 32 bits, little-endian). */
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0_LOW = 16;

/** io_uring_setup, io_uring_enter, io_uring_register: the same numbers on x86_64 and arm64. */
const IO_URING_SYSCALLS = [425, 426, 427];
/** clone3: the same number on x86_64 and arm64. */
const CLONE3 = 435;
/** open_tree, move_mount, fsopen, fsconfig, fsmount, fspick, mount_setattr: shared numbers. */
const NEW_MOUNT_API = [428, 429, 430, 431, 432, 433, 442];
/** CLONE_NEWTIME | CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET. */
const CLONE_NEW_FLAGS = 0x00000080 | 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;

interface ArchSpec {
  audit: number;
  socket: number;
  socketpair: number;
  clone: number;
  /** System calls that fail with EPERM (besides the shared mount API numbers). */
  denied: Record<string, number>;
  /** System calls at or above this number belong to another ABI (x32). */
  foreignAbove?: number;
}

const ARCHES: Record<string, ArchSpec> = {
  x64: {
    audit: 0xc000003e,
    socket: 41,
    socketpair: 53,
    clone: 56,
    foreignAbove: 0x40000000,
    denied: {
      unshare: 272, setns: 308, mount: 165, umount2: 166, pivot_root: 155, bpf: 321, perf_event_open: 298,
      userfaultfd: 323, keyctl: 250, add_key: 248, request_key: 249, process_vm_readv: 310, process_vm_writev: 311,
      open_by_handle_at: 304, kexec_load: 246, kexec_file_load: 320, init_module: 175, finit_module: 313,
      delete_module: 176, reboot: 169, swapon: 167, swapoff: 168, acct: 163,
    },
  },
  arm64: {
    audit: 0xc00000b7,
    socket: 198,
    socketpair: 199,
    clone: 220,
    denied: {
      unshare: 97, setns: 268, mount: 40, umount2: 39, pivot_root: 41, bpf: 280, perf_event_open: 241,
      userfaultfd: 282, keyctl: 219, add_key: 217, request_key: 218, process_vm_readv: 270, process_vm_writev: 271,
      open_by_handle_at: 265, kexec_load: 104, kexec_file_load: 294, init_module: 105, finit_module: 273,
      delete_module: 106, reboot: 142, swapon: 224, swapoff: 225, acct: 89,
    },
  },
};

/** The numbers `profile` denies with EPERM on `arch` (tests, docs). */
export function deniedSyscalls(arch: string = process.arch): Record<string, number> | null {
  const spec = ARCHES[arch];
  return spec ? { ...spec.denied, open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442 } : null;
}

export type SeccompProfile = "base" | "deny-unix-sockets";

type Insn = { code: number; jt?: string | number; jf?: string | number; k: number; label?: string };

function assemble(program: Insn[]): Buffer {
  const labels = new Map<string, number>();
  program.forEach((insn, index) => insn.label && labels.set(insn.label, index));
  const offset = (index: number, target: string | number | undefined): number => {
    if (target === undefined) return 0;
    if (typeof target === "number") return target;
    const to = labels.get(target);
    if (to === undefined || to <= index) throw new Error(`seccomp: bad jump to ${target}`);
    const delta = to - index - 1;
    if (delta > 255) throw new Error("seccomp: jump too far");
    return delta;
  };
  const out = Buffer.alloc(program.length * 8);
  program.forEach((insn, index) => {
    out.writeUInt16LE(insn.code, index * 8);
    out.writeUInt8(offset(index, insn.jt), index * 8 + 2);
    out.writeUInt8(offset(index, insn.jf), index * 8 + 3);
    out.writeUInt32LE(insn.k >>> 0, index * 8 + 4);
  });
  return out;
}

/** The filter for `profile` on `arch` (process.arch naming), or null when the architecture is not supported. */
export function seccompFilter(profile: SeccompProfile, arch: string = process.arch): Buffer | null {
  const spec = ARCHES[arch];
  if (!spec) return null;
  const unix = profile === "deny-unix-sockets";
  return assemble([
    { code: BPF_LD_W_ABS, k: OFFSET_ARCH },
    { code: BPF_JEQ_K, k: spec.audit, jt: 0, jf: "kill" },
    { code: BPF_LD_W_ABS, k: OFFSET_NR },
    ...(spec.foreignAbove ? [{ code: BPF_JGE_K, k: spec.foreignAbove, jt: "kill", jf: 0 }] : []),
    ...IO_URING_SYSCALLS.map((nr) => ({ code: BPF_JEQ_K, k: nr, jt: "enosys", jf: 0 })),
    { code: BPF_JEQ_K, k: CLONE3, jt: "enosys", jf: 0 },
    ...[...Object.values(spec.denied), ...NEW_MOUNT_API].map((nr) => ({ code: BPF_JEQ_K, k: nr, jt: "eperm", jf: 0 })),
    { code: BPF_JEQ_K, k: spec.clone, jt: "clone", jf: 0 },
    ...(unix
      ? [
          { code: BPF_JEQ_K, k: spec.socket, jt: "domain", jf: 0 },
          { code: BPF_JEQ_K, k: spec.socketpair, jt: "domain", jf: 0 },
        ]
      : []),
    { code: BPF_RET_K, k: SECCOMP_RET_ALLOW },
    // clone(flags, ...): flags is the first argument on both architectures; CLONE_NEW* fit in its low 32 bits.
    { code: BPF_LD_W_ABS, k: OFFSET_ARG0_LOW, label: "clone" },
    { code: BPF_JSET_K, k: CLONE_NEW_FLAGS, jt: "eperm", jf: 0 },
    { code: BPF_RET_K, k: SECCOMP_RET_ALLOW },
    ...(unix
      ? [
          { code: BPF_LD_W_ABS, k: OFFSET_ARG0_LOW, label: "domain" },
          { code: BPF_JEQ_K, k: AF_UNIX, jt: 0, jf: "allow" },
          { code: BPF_RET_K, k: SECCOMP_RET_ERRNO | EAFNOSUPPORT },
          { code: BPF_RET_K, k: SECCOMP_RET_ALLOW, label: "allow" },
        ]
      : []),
    { code: BPF_RET_K, k: SECCOMP_RET_ERRNO | ENOSYS, label: "enosys" },
    { code: BPF_RET_K, k: SECCOMP_RET_ERRNO | EPERM, label: "eperm" },
    { code: BPF_RET_K, k: SECCOMP_RET_KILL_PROCESS, label: "kill" },
  ]);
}

/** Whether this host's architecture has filters (bubblewrap refuses to start without them). */
export function seccompSupported(arch: string = process.arch): boolean {
  return arch in ARCHES;
}

/**
 * Write the filter into `dir` (worker-owned, never mounted into a sandbox) and return its path.
 * Throws when the architecture is unsupported: no command runs without its filter.
 */
export function ensureSeccompFilterFile(dir: string, profile: SeccompProfile, arch: string = process.arch): string {
  const filter = seccompFilter(profile, arch);
  if (!filter) throw new Error(`no seccomp filter for architecture ${arch}; refusing to run the command without it`);
  const file = path.join(dir, `seccomp-${profile}-${arch}.bpf`);
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (stat.isFile() && stat.uid === process.getuid?.() && readFileSync(file).equals(filter)) return file;
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, filter, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return file;
}
