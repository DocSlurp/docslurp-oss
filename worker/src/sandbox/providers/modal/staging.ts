import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { VM_PDF_MAX_SOURCE_BYTES } from "@docslurp/shared";
import { createHash } from "node:crypto";

import { SandboxOutputError, SandboxOutputLimitError } from "../../types.js";

/** One remote filesystem entry. `mtime` is in the remote clock's units (Modal reports whole seconds). */
export interface RemoteEntry {
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** Minimal remote filesystem surface the staging logic needs; implemented over the Modal SDK. */
export interface RemoteFs {
  /** The entry at `p`, or null when nothing exists there. */
  stat(p: string): Promise<RemoteEntry | null>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  writeFromLocal?(p: string, local: string): Promise<void>;
  /** Read a file, failing (without buffering past it) once it exceeds `limit` bytes. */
  readFile(p: string, limit?: number): Promise<Uint8Array>;
  /** Direct children of a directory, symlinks excluded. */
  list(p: string): Promise<RemoteEntry[]>;
  mkdir(p: string): Promise<void>;
  /** Create several directories (with parents) in one call, when the transport can (council X #7). */
  mkdirAll?(paths: string[]): Promise<void>;
  /** Remove a file, or a directory and everything under it. */
  remove(p: string): Promise<void>;
}

type ClaimKind = "upload" | "download" | "directory";

/** The state of a command's writable paths just before it ran. */
export interface RemoteSnapshot {
  readonly roots: string[];
  readonly entries: ReadonlyMap<string, RemoteEntry>;
  /** Staging sequence number when the snapshot was taken; later uploads and downloads have higher numbers. */
  readonly seq: number;
}

/**
 * Mirrors local absolute paths into a remote sandbox (same path string, so command
 * arguments need no rewriting) and moves each command's own writes back afterwards.
 *
 * Every command's writable paths are snapshotted before it runs. A command that exits
 * downloads only the files it created or changed; a command that was aborted or timed
 * out has its changes removed remotely instead, so no later download can copy them back.
 */
export class SessionStaging {
  private readonly uploaded = new Set<string>();
  private readonly inputHashes = new Map<string, string>();
  /** Path -> the last upload, download or directory creation that put it there, by sequence number. */
  private readonly claims = new Map<string, { seq: number; kind: ClaimKind }>();
  private seq = 0;

  constructor(private readonly remote: RemoteFs) {}

  /** Upload each local file or directory (recursively) when their content changes. Missing paths and symlinks are skipped. */
  async ensureUploaded(paths: string[]): Promise<void> {
    for (const p of paths) await this.upload(path.resolve(p));
  }

  /** Create remote directories (with parents). */
  async ensureDirectories(paths: string[]): Promise<void> {
    const resolved = paths.map((p) => path.resolve(p));
    if (resolved.length > 1 && this.remote.mkdirAll) await this.remote.mkdirAll(resolved);
    else for (const abs of resolved) await this.remote.mkdir(abs);
    for (const abs of resolved) this.claim(abs, "directory");
  }

  /** Paths uploaded and still assumed present (kept across the same document's commands, council X #7). */
  uploadedPaths(): string[] {
    return [...this.uploaded];
  }

  /** Record the current state of `roots` so a command's own changes can be told apart later. */
  async snapshot(roots: string[]): Promise<RemoteSnapshot> {
    const resolved = roots.map((p) => path.resolve(p));
    const seq = this.seq;
    return { roots: resolved, entries: await this.walk(resolved), seq };
  }

  /**
   * Copy back what changed under the snapshot's roots since it was taken: new and modified
   * files, and new directories. Inputs uploaded for another command meanwhile are not copied
   * back. A root the command never created is skipped silently.
   */
  async download(snapshot: RemoteSnapshot, options: { maxBytes?: number } = {}): Promise<void> {
    const changed = this.changes(snapshot, await this.walk(snapshot.roots));
    // A command's own budget (SandboxLimits.maxOutputBytes) only ever lowers the general limits, per file and in total.
    const fileLimit = Math.min(128 * 1024 * 1024, options.maxBytes ?? Number.POSITIVE_INFINITY);
    const totalLimit = Math.min(512 * 1024 * 1024, options.maxBytes ?? Number.POSITIVE_INFINITY);
    let totalBytes = 0;
    for (const entry of changed) {
      if (!entry.isDir) {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > fileLimit) throw new SandboxOutputLimitError("parser VM output file exceeds limit");
        totalBytes += entry.size;
        if (totalBytes > totalLimit) throw new SandboxOutputLimitError("parser VM aggregate output exceeds limit");
      }
    }
    let downloadedBytes = 0;
    for (const entry of changed) {
      const claim = this.claims.get(entry.path);
      if (claim?.kind === "upload" && claim.seq > snapshot.seq) continue;
      if (entry.isDir) await mkdir(entry.path, { recursive: true });
      else {
        await mkdir(path.dirname(entry.path), { recursive: true });
        // Each read is bounded by what is left of the budget (a file may grow after its size was listed).
        const data = await this.remote.readFile(entry.path, Math.min(fileLimit, totalLimit - downloadedBytes));
        downloadedBytes += data.byteLength;
        if (data.byteLength > fileLimit || downloadedBytes > totalLimit) throw new SandboxOutputLimitError("parser VM actual output exceeds limit");
        await writeFile(entry.path, data);
      }
      this.claim(entry.path, "download");
    }
  }

  /**
   * Remove remotely what changed under the snapshot's roots since it was taken, except paths a
   * later upload, download or directory creation put there (those belong to other commands).
   * Removed paths are forgotten as uploaded, so an input the command modified is re-uploaded
   * the next time a command declares it. Returns the removed paths.
   */
  async discard(snapshot: RemoteSnapshot): Promise<string[]> {
    const changed = this.changes(snapshot, await this.walk(snapshot.roots));
    const claimedSince = [...this.claims].filter(([, claim]) => claim.seq > snapshot.seq).map(([p]) => p);
    const isClaimed = (p: string) => claimedSince.some((c) => c === p || c.startsWith(`${p}${path.sep}`));
    const removed: string[] = [];
    // Parents sort before children, so a removed new directory takes its subtree with it.
    for (const entry of changed.sort((a, b) => a.path.localeCompare(b.path))) {
      if (removed.some((r) => entry.path.startsWith(`${r}${path.sep}`))) continue;
      if (isClaimed(entry.path)) continue;
      // A directory that already existed only changed through its children; handle those.
      if (entry.isDir && snapshot.entries.get(entry.path)?.isDir) continue;
      await this.remote.remove(entry.path);
      this.forget(entry.path);
      removed.push(entry.path);
    }
    return removed;
  }

  private claim(abs: string, kind: ClaimKind): void {
    this.claims.set(abs, { seq: ++this.seq, kind });
  }

  /** Drop a removed path, its subtree and its ancestors from the uploaded set so they upload again. */
  /**
   * Forget every upload (recheck S #7): the next command re-uploads all its inputs. Called when a VM moves to another
   * document, whose parser could have rewritten this document's remote copies.
   */
  forgetUploads(): void {
    this.uploaded.clear();
    this.inputHashes.clear();
  }

  private forget(abs: string): void {
    for (const p of this.uploaded) if (p === abs || p.startsWith(`${abs}${path.sep}`)) { this.uploaded.delete(p); this.inputHashes.delete(p); }
    for (let p = path.dirname(abs); ; p = path.dirname(p)) {
      this.uploaded.delete(p);
      if (p === path.dirname(p)) break;
    }
  }

  /** Entries new or modified relative to the snapshot (including new directories). */
  private changes(snapshot: RemoteSnapshot, current: Map<string, RemoteEntry>): RemoteEntry[] {
    const changed: RemoteEntry[] = [];
    for (const entry of current.values()) {
      const before = snapshot.entries.get(entry.path);
      if (!before || before.isDir !== entry.isDir) changed.push(entry);
      else if (!entry.isDir && (before.size !== entry.size || before.mtime !== entry.mtime)) changed.push(entry);
    }
    return changed;
  }

  private async walk(roots: string[]): Promise<Map<string, RemoteEntry>> {
    const entries = new Map<string, RemoteEntry>();
    const visit = async (entry: RemoteEntry): Promise<void> => {
      // The listing is the guest's word: a `..` or `.` segment would pass a prefix test and still leave the root.
      if (!isPlainChildPath(entry.path) || !roots.some((root) => entry.path === root || entry.path.startsWith(root + path.sep))) throw new SandboxOutputError("parser VM output escaped staging roots");
      if (entries.has(entry.path)) return;
      if (entries.size >= 8192 || entry.path.split(path.sep).length > 64) throw new SandboxOutputError("parser VM output entry/depth limit exceeded");
      entries.set(entry.path, entry);
      if (entry.isDir) for (const child of await this.remote.list(entry.path)) await visit(child);
    };
    for (const root of roots) {
      const entry = await this.remote.stat(root);
      if (entry && entry.path !== root) throw new SandboxOutputError("parser VM output escaped staging roots");
      if (entry) await visit(entry);
    }
    return entries;
  }

  private async upload(abs: string): Promise<void> {
    let stats;
    try {
      stats = await lstat(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) return;
    this.uploaded.add(abs);
    if (stats.isDirectory()) {
      await this.remote.mkdir(abs);
      this.claim(abs, "upload");
      for (const name of await readdir(abs)) await this.upload(path.join(abs, name));
    } else if (stats.isFile()) {
      if (stats.size > VM_PDF_MAX_SOURCE_BYTES) throw new SandboxOutputError("parser VM input file exceeds limit");
      if (stats.size > 8 * 1024 * 1024) {
        if (!this.remote.writeFromLocal) throw new SandboxOutputError("parser VM streaming input transfer unavailable");
        const directory = await mkdtemp(path.join(tmpdir(), "parser-input-"));
        const local = path.join(directory, "source");
        try {
          const file = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const before = await file.stat();
            if (!before.isFile() || before.size !== stats.size || before.ino !== stats.ino || before.dev !== stats.dev) throw new SandboxOutputError("parser VM input changed");
            const digest = createHash("sha256");
            let total = 0;
            const output = await open(local, "wx", 0o600);
            try {
              await pipeline(file.createReadStream({ autoClose: false }), async function* (input) {
                for await (const chunk of input) {
                  total += chunk.length;
                  if (total > before.size) throw new SandboxOutputError("parser VM input grew");
                  digest.update(chunk);
                  yield chunk;
                }
              }, output.createWriteStream());
            } finally { await output.close(); }
            const after = await file.stat();
            if (total !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new SandboxOutputError("parser VM input changed");
            const hash = digest.digest("hex");
            if (this.inputHashes.get(abs) !== hash) {
              await this.remote.writeFromLocal(abs, local);
              this.inputHashes.set(abs, hash);
              this.claim(abs, "upload");
            }
          } finally { await file.close(); }
        } finally { await rm(directory, { recursive: true, force: true }); }
        return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      // Bound allocation while reading, including growth after the initial stat.
      for await (const chunk of createReadStream(abs)) {
        bytes += chunk.length;
        if (bytes > stats.size) throw new SandboxOutputError("parser VM actual input file exceeds limit");
        chunks.push(chunk as Buffer);
      }
      const data = Buffer.concat(chunks, bytes);
      const hash = createHash("sha256").update(data).digest("hex");
      if (this.inputHashes.get(abs) === hash) return;
      await this.remote.writeFile(abs, data);
      this.inputHashes.set(abs, hash);
      this.claim(abs, "upload");
    }
  }
}

/** An absolute path with no `.`/`..` or empty segment: what a directory listing of our own roots can honestly contain. */
export function isPlainChildPath(p: string): boolean {
  return path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith(path.sep);
}
