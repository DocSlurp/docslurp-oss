import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ScannerSessionSpec } from "../../types.js";

/**
 * Malware scanner snapshots (quarantine fast path, Q1).
 *
 * A scanner snapshot is a memory snapshot of a hardened, locked parser VM in which clamd has loaded one signature set and
 * nothing else has happened: it is built from the worker's own signature files before any job input exists, and no job
 * command ever runs in the VM it is taken from. Scan jobs restore fresh VMs from it, so the signature load (seconds of CPU
 * per VM) and the image lock happen once per signature set instead of once per document. A restored VM serves one
 * organization and is terminated with its session; nothing a job wrote is ever in a snapshot.
 */

/** Root-owned home of the clamd configuration in a scanner VM, outside every job tree. */
export const SCANNER_CONFIG_DIR = "/etc/docslurp-clamd";
export const SCANNER_CONFIG_FILE = `${SCANNER_CONFIG_DIR}/clamd.conf`;
/** clamd's socket directory: owned by clamd's user, 0755, so the parser user can connect but never replace the socket. */
export const SCANNER_SOCKET_DIR = "/run/docslurp-clamd";
export const SCANNER_SOCKET = `${SCANNER_SOCKET_DIR}/clamd.sock`;
/** clamd's own temporary directory, owned by its unprivileged user and outside the parser scratch roots. */
export const SCANNER_TEMP_DIR = "/var/lib/docslurp-clamd";
/** The unprivileged user clamd drops to after loading (created by the image's clamav package). */
export const SCANNER_DAEMON_USER = "clamav";
export const CLAMD_BINARY = "/usr/sbin/clamd";

/** The VM directory a signature set is staged in for its snapshot (content-named, under the asset root). */
export function scannerDefinitionsDir(assetRoot: string, signatureSetHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(signatureSetHash)) throw new Error("invalid signature set hash");
  return `${assetRoot}/clam-${signatureSetHash.slice(0, 32)}`;
}

/**
 * clamd configuration for a scanner VM. Scan limits are clamd's defaults, which are libclamav's, the same ones clamscan
 * applies today: a scanner verdict is the verdict clamscan would give for the same file and signatures.
 */
export function clamdConfig(definitionsDir: string): string {
  return [
    `LocalSocket ${SCANNER_SOCKET}`,
    // The parser user runs clamdscan --fdpass and must connect; the directory (root 0755) keeps the path itself fixed.
    "LocalSocketMode 666",
    "FixStaleSocket yes",
    `DatabaseDirectory ${definitionsDir}`,
    `TemporaryDirectory ${SCANNER_TEMP_DIR}`,
    `User ${SCANNER_DAEMON_USER}`,
    "Foreground no",
    // The signature set is fixed for the snapshot's life: no reload, no self-check that could reload it.
    "SelfCheck 0",
    "ConcurrentDatabaseReload no",
    "MaxThreads 4",
    "LogTime no",
    "",
  ].join("\n");
}

/** Root setup before clamd starts: its directories, config and temp directory (exit non-zero on any failure). */
export function scannerSetupArgv(): string[] {
  const script = [
    "set -eu",
    `install -d -o root -g root -m 0755 ${SCANNER_CONFIG_DIR}`,
    // clamd binds its socket after dropping to its user: that user owns the directory; the parser user cannot write it.
    `install -d -o ${SCANNER_DAEMON_USER} -g ${SCANNER_DAEMON_USER} -m 0755 ${SCANNER_SOCKET_DIR}`,
    `install -d -o ${SCANNER_DAEMON_USER} -g ${SCANNER_DAEMON_USER} -m 0700 ${SCANNER_TEMP_DIR}`,
  ].join("\n");
  return ["/bin/sh", "-c", script];
}

/** Starts clamd as root (it drops to SCANNER_DAEMON_USER); returns once the signatures are loaded and it has daemonized. */
export const CLAMD_START_ARGV = [CLAMD_BINARY, `--config-file=${SCANNER_CONFIG_FILE}`];

/** The daemon's own report of what it loaded: `ClamAV <engine>/<daily version>/<signature date>`. */
export const CLAMD_VERSION_ARGV = ["clamdscan", `--config-file=${SCANNER_CONFIG_FILE}`, "--version"];

/**
 * Self-test as root against an authored EICAR file outside every job tree: the daemon must answer and detect it, or the
 * snapshot is never taken. The test file is removed before the snapshot.
 */
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
export const SELF_TEST_FILE = `${SCANNER_CONFIG_DIR}/self-test.txt`;
export const CLAMD_SELF_TEST_ARGV = ["clamdscan", `--config-file=${SCANNER_CONFIG_FILE}`, "--fdpass", "--no-summary", "--infected", SELF_TEST_FILE];

/**
 * Lists every entry under the job roots (path, type, owner, size), sorted, as root. Taken right after the build VM starts
 * and again right before its snapshot: the two must match apart from the control directory, so the snapshot provably holds
 * nothing in a job tree beyond what the image itself ships (and the build never uploads into one).
 */
export function jobRootsListingArgv(jobRoots: readonly string[]): string[] {
  const script = [
    "import os, stat, sys",
    "out = []",
    "for root in sys.argv[1:]:",
    "    if not os.path.lexists(root): out.append('absent ' + root); continue",
    "    for base, dirs, files in os.walk(root):",
    "        for name in [None] + dirs + files:",
    "            p = base if name is None else os.path.join(base, name)",
    "            try: st = os.lstat(p)",
    "            except OSError: continue",
    "            out.append('%s %o %d %d' % (p, stat.S_IFMT(st.st_mode), st.st_uid, st.st_size if stat.S_ISREG(st.st_mode) else 0))",
    "print('\\n'.join(sorted(set(out))))",
  ].join("\n");
  return ["python3", "-I", "-c", script, ...jobRoots];
}

/** What a job-root listing gained between two listings, ignoring the control directory (which holds no job data yet). */
export function jobRootsGained(before: string, after: string, controlDir: string): string[] {
  const seen = new Set(before.split("\n").filter(Boolean));
  return after.split("\n").filter(Boolean).filter((line) => !seen.has(line)).filter((line) => {
    const entry = line.split(" ")[0]!;
    return entry !== controlDir && !entry.startsWith(`${controlDir}/`) && !controlDir.startsWith(`${entry}/`);
  });
}

/** The daily version and date a clamd/clamscan version line reports, or null when it is not one. */
export function parseClamVersionLine(line: string): { version: number; date: string } | null {
  const parts = line.trim().split("/");
  if (parts.length !== 3 || !/^ClamAV [0-9.]+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) return null;
  return { version: Number(parts[1]), date: parts[2]!.trim() };
}

/** The signature files of a staged definitions directory, in name order, read for upload into the snapshot VM. */
export async function readDefinitionFiles(dir: string, limitBytes = 512 * 1024 * 1024): Promise<Array<{ name: string; data: Buffer }>> {
  const files: Array<{ name: string; data: Buffer }> = [];
  let total = 0;
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^(?:main|daily|bytecode)\.(?:cvd|cld)$/.test(entry.name)) continue;
    const data = await readFile(path.join(dir, entry.name));
    total += data.byteLength;
    if (total > limitBytes) throw new Error("ClamAV signature assets exceed transfer limit");
    files.push({ name: entry.name, data });
  }
  if (!files.some((file) => file.name.startsWith("daily."))) throw new Error("ClamAV daily signatures missing; refusing to build a scanner snapshot");
  return files;
}

/** Cache key of a scanner snapshot: one per image, VM size, region and signature set. */
export function scannerSnapshotKey(image: { image: string; imageId?: string }, size: { cpu: number; memoryMb: number }, regions: readonly string[], spec: Pick<ScannerSessionSpec, "signatureSetHash" | "expectedVersion">): string {
  return [image.imageId ?? image.image, size.cpu, size.memoryMb, regions.join(","), spec.signatureSetHash, spec.expectedVersion].join("|");
}

/**
 * Process-wide scanner snapshots by key. One build at a time per key; a failed build is forgotten so the next scan
 * retries it. Only the newest signature set is kept: a new key replaces older entries (their VMs are already gone).
 */
export class ScannerSnapshotCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  get(key: string, build: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      for (const old of [...this.entries.keys()]) if (old !== key) this.entries.delete(old);
      entry = build();
      this.entries.set(key, entry);
      entry.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    }
    return entry;
  }

  /** Drop a snapshot that failed to restore, so the next scan builds a new one. */
  forget(key: string, entry?: Promise<T>): void {
    if (!entry || this.entries.get(key) === entry) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Regions scanner snapshot VMs run in (DOCSLURP_MODAL_SCANNER_REGIONS, comma list; default "us": memory snapshots of VM sandboxes need a region). */
export function modalScannerRegions(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.DOCSLURP_MODAL_SCANNER_REGIONS ?? "us").split(",").map((item) => item.trim()).filter(Boolean);
  for (const region of raw) if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error(`invalid DOCSLURP_MODAL_SCANNER_REGIONS entry: ${region}`);
  return raw.length ? raw : ["us"];
}
