import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { clamdLimitLines } from "../../../tools/clam-limits.js";
import type { ScannerSessionSpec } from "../../types.js";

/**
 * Malware scanner snapshots (quarantine fast path, Q1).
 *
 * A scanner snapshot is a memory snapshot of a hardened, locked parser VM in which clamd has loaded one signature set and
 * nothing else has happened: it is built from the worker's own signature files before any job input exists, and no job
 * command ever runs in the VM it is taken from. Scan jobs restore fresh VMs from it, so the signature load (seconds of CPU
 * per VM) and the image lock happen once per signature set instead of once per document. A scanner session serves one
 * document of one organization, its VMs are terminated with it, and nothing a job wrote is ever in a snapshot.
 *
 * Every restored VM resumes the same memory, userspace random-number state included (council L2: a Python process started
 * before the snapshot printed the same random() in two restores; the kernel RNG is reseeded). The snapshot therefore holds
 * nothing that needs per-VM randomness or secrecy, such as keys, tokens or nonces: only the image, the worker's signature
 * files, the clamd config and the loaded daemon. Keep it that way.
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
 * clamd configuration for a scanner VM. Scan limits are CLAM_SCAN_LIMITS, the ones the per-command clamscan applies too
 * (clam-limits.ts): every byte quarantine accepts is scanned, and a limit hit is a detection, never a clean verdict.
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
    ...clamdLimitLines(),
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
export const CLAMD_SELF_TEST_ARGV = clamdSelfTestArgv(SELF_TEST_FILE);

/** clamdscan of one root-owned self-test file through the scanner VM's daemon. */
export function clamdSelfTestArgv(file: string): string[] {
  return ["clamdscan", `--config-file=${SCANNER_CONFIG_FILE}`, "--fdpass", "--no-summary", "--infected", file];
}

/**
 * Lists every entry under the job roots (path, full mode, owner, group, size), sorted, as root. Taken right after the
 * build VM is hardened and locked (the state of any fresh parser VM) and again right before its snapshot: the two must
 * match exactly, so the snapshot's job trees are a fresh parser VM's, and the build provably left nothing in them.
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
    "            out.append('%r %o %d %d %d' % (p, st.st_mode, st.st_uid, st.st_gid, st.st_size if stat.S_ISREG(st.st_mode) else 0))",
    "print('\\n'.join(sorted(set(out))))",
  ].join("\n");
  return ["python3", "-I", "-c", script, ...jobRoots];
}

/**
 * Every line two job-root listings disagree on (added, removed or changed), compared exactly: nothing is exempt, not
 * the control directory nor any ancestor of it, so a changed mode or owner of, say, /tmp is reported (council L5).
 */
export function jobRootsChanged(before: string, after: string): string[] {
  const lines = (text: string) => new Set(text.split("\n").filter(Boolean));
  const was = lines(before);
  const now = lines(after);
  return [...[...now].filter((line) => !was.has(line)), ...[...was].filter((line) => !now.has(line))];
}

/**
 * Root-side egress check for a VM restored from a snapshot: connecting to public addresses must fail (exit 0). Exit 3 when
 * any connection succeeds. A blocked network refuses at once (measured: OSError, not a timeout), so this costs one exec.
 */
export const RESTORED_EGRESS_CHECK_ARGV = [
  "python3", "-I", "-c",
  [
    "import socket, sys",
    "for family, addr in ((socket.AF_INET, ('1.1.1.1', 443)), (socket.AF_INET, ('8.8.8.8', 53)), (socket.AF_INET6, ('2606:4700:4700::1111', 443))):",
    "    try:",
    "        s = socket.socket(family, socket.SOCK_STREAM); s.settimeout(2); s.connect(addr)",
    "    except OSError:",
    "        continue",
    "    print('egress open', addr[0]); sys.exit(3)",
    "print('egress blocked')",
  ].join("\n"),
];

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
 * Process-wide scanner snapshots by key. One build at a time per key. The two most recently used keys are kept, so two
 * signature sets staged side by side during an update (A, B, A, B) build twice, not four times (council L3). A failed
 * build is remembered for `failureBackoffMs`: scans in that window fail at once (an error verdict, fail closed) instead
 * of each paying for another full build that would fail the same way; the first scan after it retries.
 *
 * Builds in flight live in their own map and are never evicted, so the LRU bound (completed snapshots only) cannot start
 * a second build of a key that is still building (council re-check L1: A, B, C, A built A twice). A build's completion or
 * failure updates the cache only while it is still that key's current build: one dropped by `forget` changes nothing.
 *
 * Every map is bounded (council re-check 2, L1): failures expire after their backoff and at most `maxFailures` are held
 * (oldest dropped: that key may then retry early, never pass); at most `maxBuilding` builds run at once, and a scan that
 * would start another fails at once (an error verdict, fail closed) rather than growing the map.
 */
export class ScannerSnapshotCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  private readonly building = new Map<string, Promise<T>>();
  private readonly failures = new Map<string, { until: number; error: unknown }>();

  constructor(
    private readonly keep = 2,
    private readonly failureBackoffMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxBuilding = 4,
    private readonly maxFailures = 16,
  ) {}

  get(key: string, build: () => Promise<T>): Promise<T> {
    const now = this.now();
    for (const [failedKey, failure] of this.failures) if (failure.until <= now) this.failures.delete(failedKey);
    const failed = this.failures.get(key);
    if (failed) return Promise.reject(failed.error);
    const entry = this.entries.get(key);
    if (entry) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry;
    }
    const pending = this.building.get(key);
    if (pending) return pending;
    if (this.building.size >= Math.max(1, this.maxBuilding)) {
      return Promise.reject(new Error(`scanner snapshot builds in flight are at their limit (${this.maxBuilding}); refusing to start another`));
    }
    const started = build();
    this.building.set(key, started);
    started.then(
      () => {
        if (this.building.get(key) !== started) return;
        this.building.delete(key);
        this.failures.delete(key);
        this.entries.delete(key);
        this.entries.set(key, started);
        while (this.entries.size > Math.max(1, this.keep)) this.entries.delete(this.entries.keys().next().value!);
      },
      (error: unknown) => {
        if (this.building.get(key) !== started) return;
        this.building.delete(key);
        this.failures.delete(key);
        this.failures.set(key, { until: this.now() + this.failureBackoffMs, error });
        while (this.failures.size > Math.max(1, this.maxFailures)) this.failures.delete(this.failures.keys().next().value!);
      },
    );
    return started;
  }

  /** Drop a snapshot that failed to restore, so the next scan builds a new one (no backoff: the build itself worked). */
  forget(key: string, entry?: Promise<T>): void {
    if (!entry || this.entries.get(key) === entry) this.entries.delete(key);
    if (!entry || this.building.get(key) === entry) this.building.delete(key);
  }

  /** Completed snapshots held (builds in flight are not counted). */
  get size(): number {
    return this.entries.size;
  }

  /** Builds in flight. */
  get pendingBuilds(): number {
    return this.building.size;
  }

  /** Failed keys still held (expired ones are dropped on the next `get`). */
  get failedKeys(): number {
    return this.failures.size;
  }
}

/** DOCSLURP_QUARANTINE_SCAN_SNAPSHOT: scan in VMs restored from a clean, signature-loaded snapshot (default off). */
export function quarantineScanSnapshotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DOCSLURP_QUARANTINE_SCAN_SNAPSHOT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Regions scanner snapshot VMs run in (DOCSLURP_MODAL_SCANNER_REGIONS, comma list; default "us": memory snapshots of VM
 * sandboxes need a region). Read only when the snapshot flag is on: with it off the variable is ignored, as it was before
 * scanner snapshots existed, so a bad value cannot take the parser sandbox down (council L4).
 */
export function modalScannerRegions(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  if (!quarantineScanSnapshotEnabled(env)) return undefined;
  const raw = (env.DOCSLURP_MODAL_SCANNER_REGIONS ?? "us").split(",").map((item) => item.trim()).filter(Boolean);
  for (const region of raw) if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error(`invalid DOCSLURP_MODAL_SCANNER_REGIONS entry: ${region}`);
  return raw.length ? raw : ["us"];
}
