import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Minimal remote filesystem surface the staging logic needs; implemented over the Modal SDK. */
export interface RemoteFs {
  exists(p: string): Promise<boolean>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  readFile(p: string): Promise<Uint8Array>;
  list(p: string): Promise<{ path: string; isDir: boolean }[]>;
  mkdir(p: string): Promise<void>;
}

/**
 * Mirrors local absolute paths into a remote sandbox (same path string, so command
 * arguments need no rewriting) and copies declared writable paths back afterwards.
 */
export class SessionStaging {
  private readonly uploaded = new Set<string>();

  constructor(private readonly remote: RemoteFs) {}

  /** Upload each local file or directory (recursively) once per session. Missing paths and symlinks are skipped. */
  async ensureUploaded(paths: string[]): Promise<void> {
    for (const p of paths) await this.upload(path.resolve(p));
  }

  /** Copy remote paths back to the same local paths. A path the command never created is skipped silently. */
  async download(paths: string[]): Promise<void> {
    for (const p of paths) {
      const abs = path.resolve(p);
      if (!(await this.remote.exists(abs))) continue;
      await this.fetch(abs, await this.isRemoteDir(abs));
    }
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
      for (const name of await readdir(abs)) await this.upload(path.join(abs, name));
    } else if (stats.isFile()) {
      await this.remote.writeFile(abs, await readFile(abs));
    }
  }

  private async isRemoteDir(abs: string): Promise<boolean> {
    const parent = path.dirname(abs);
    if (parent === abs) return true;
    const siblings = await this.remote.list(parent);
    return siblings.find((entry) => entry.path === abs)?.isDir ?? false;
  }

  private async fetch(abs: string, isDir: boolean): Promise<void> {
    if (!isDir) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, await this.remote.readFile(abs));
      return;
    }
    await mkdir(abs, { recursive: true });
    for (const entry of await this.remote.list(abs)) await this.fetch(entry.path, entry.isDir);
  }
}
