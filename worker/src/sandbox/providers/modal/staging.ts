import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  readFile(p: string): Promise<Uint8Array>;
  /** Direct children of a directory, symlinks excluded. */
  list(p: string): Promise<RemoteEntry[]>;
  mkdir(p: string): Promise<void>;
  /** Remove a file, or a directory and everything under it. */
  remove(p: string): Promise<void>;
}

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
  /** Path -> sequence number of the last upload, download or directory creation that put it there. */
  private readonly claims = new Map<string, number>();
  private seq = 0;

  constructor(private readonly remote: RemoteFs) {}

  /** Upload each local file or directory (recursively) once per session. Missing paths and symlinks are skipped. */
  async ensureUploaded(paths: string[]): Promise<void> {
    for (const p of paths) await this.upload(path.resolve(p));
  }

  /** Create remote directories (with parents). */
  async ensureDirectories(paths: string[]): Promise<void> {
    for (const p of paths) {
      const abs = path.resolve(p);
      await this.remote.mkdir(abs);
      this.claim(abs);
    }
  }

  /** Record the current state of `roots` so a command's own changes can be told apart later. */
  async snapshot(roots: string[]): Promise<RemoteSnapshot> {
    const resolved = roots.map((p) => path.resolve(p));
    const seq = this.seq;
    return { roots: resolved, entries: await this.walk(resolved), seq };
  }

  /**
   * Copy back what changed under the snapshot's roots since it was taken: new and modified
   * files, and new directories. A root the command never created is skipped silently.
   */
  async download(snapshot: RemoteSnapshot): Promise<void> {
    const changed = this.changes(snapshot, await this.walk(snapshot.roots));
    for (const entry of changed) {
      if (entry.isDir) await mkdir(entry.path, { recursive: true });
      else {
        await mkdir(path.dirname(entry.path), { recursive: true });
        await writeFile(entry.path, await this.remote.readFile(entry.path));
      }
      this.claim(entry.path);
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
    const claimedSince = [...this.claims].filter(([, seq]) => seq > snapshot.seq).map(([p]) => p);
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

  private claim(abs: string): void {
    this.claims.set(abs, ++this.seq);
  }

  /** Drop a removed path, its subtree and its ancestors from the uploaded set so they upload again. */
  private forget(abs: string): void {
    for (const p of this.uploaded) if (p === abs || p.startsWith(`${abs}${path.sep}`)) this.uploaded.delete(p);
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
      if (entries.has(entry.path)) return;
      entries.set(entry.path, entry);
      if (entry.isDir) for (const child of await this.remote.list(entry.path)) await visit(child);
    };
    for (const root of roots) {
      const entry = await this.remote.stat(root);
      if (entry) await visit(entry);
    }
    return entries;
  }

  private async upload(abs: string): Promise<void> {
    if (this.uploaded.has(abs)) return;
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
      this.claim(abs);
      for (const name of await readdir(abs)) await this.upload(path.join(abs, name));
    } else if (stats.isFile()) {
      await this.remote.writeFile(abs, await readFile(abs));
      this.claim(abs);
    }
  }
}
