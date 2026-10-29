import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A classic-BPF seccomp filter, generated here (no libseccomp), that makes socket(AF_UNIX, ...)
 * and socketpair(AF_UNIX, ...) fail with EAFNOSUPPORT and allows every other system call. bwrap
 * installs it for the sandboxed command (`--seccomp FD`).
 *
 * Why: two commands that share nothing but a writable directory could otherwise meet on a UNIX
 * socket and pass file descriptors (SCM_RIGHTS), for example one command holding another's stdout
 * open so that its teardown cannot be verified, which quarantines the worker. Under bubblewrap each
 * command has its own network namespace, so abstract sockets are private already; this closes the
 * filesystem-socket path for commands that never need a UNIX socket (poppler tools). It is not
 * applied to commands that may (clamdscan talks to clamd over one, LibreOffice uses one for IPC).
 *
 * A system call from a foreign ABI (x32, or 32-bit compat on x86_64) kills the process: it could
 * otherwise reach socket() under a number this filter does not check.
 */

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_RET_K = 0x06;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EAFNOSUPPORT = 97;
const AF_UNIX = 1;

/** seccomp_data offsets: nr, arch, args[0] (low 32 bits, little-endian). */
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0_LOW = 16;

interface ArchSpec {
  audit: number;
  socket: number;
  socketpair: number;
  /** System calls at or above this number belong to another ABI (x32). */
  foreignAbove?: number;
}

const ARCHES: Record<string, ArchSpec> = {
  x64: { audit: 0xc000003e, socket: 41, socketpair: 53, foreignAbove: 0x40000000 },
  arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199 },
};

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

/** The filter for `arch` (process.arch naming), or null when this architecture is not supported. */
export function denyUnixSocketsFilter(arch: string = process.arch): Buffer | null {
  const spec = ARCHES[arch];
  if (!spec) return null;
  return assemble([
    { code: BPF_LD_W_ABS, k: OFFSET_ARCH },
    { code: BPF_JEQ_K, k: spec.audit, jt: 0, jf: "kill" },
    { code: BPF_LD_W_ABS, k: OFFSET_NR },
    ...(spec.foreignAbove ? [{ code: BPF_JGE_K, k: spec.foreignAbove, jt: "kill", jf: 0 }] : []),
    { code: BPF_JEQ_K, k: spec.socket, jt: "domain", jf: 0 },
    { code: BPF_JEQ_K, k: spec.socketpair, jt: "domain", jf: 0 },
    { code: BPF_RET_K, k: SECCOMP_RET_ALLOW },
    { code: BPF_LD_W_ABS, k: OFFSET_ARG0_LOW, label: "domain" },
    { code: BPF_JEQ_K, k: AF_UNIX, jt: 0, jf: "allow" },
    { code: BPF_RET_K, k: SECCOMP_RET_ERRNO | EAFNOSUPPORT },
    { code: BPF_RET_K, k: SECCOMP_RET_ALLOW, label: "allow" },
    { code: BPF_RET_K, k: SECCOMP_RET_KILL_PROCESS, label: "kill" },
  ]);
}

/**
 * Write the filter into `dir` (worker-owned, never mounted into a sandbox) and return its path.
 * Throws when the architecture is unsupported: a command that asked for the filter must not run
 * without it.
 */
export function ensureDenyUnixSocketsFilterFile(dir: string, arch: string = process.arch): string {
  const filter = denyUnixSocketsFilter(arch);
  if (!filter) throw new Error(`no UNIX-socket seccomp filter for architecture ${arch}; refusing to run the command without it`);
  const file = path.join(dir, `deny-unix-sockets-${arch}.bpf`);
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
