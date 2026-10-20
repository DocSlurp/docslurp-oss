import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModalProvider, type ModalSdk } from "../providers/modal/index.js";
import { SessionStaging, type RemoteFs } from "../providers/modal/staging.js";
import { SandboxConfigError } from "../types.js";

class MemoryRemoteFs implements RemoteFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/"]);
  writes: string[] = [];

  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async writeFile(p: string, data: Uint8Array) {
    this.writes.push(p);
    this.files.set(p, data);
  }
  async readFile(p: string) {
    const data = this.files.get(p);
    if (!data) throw new Error(`ENOENT ${p}`);
    return data;
  }
  async mkdir(p: string) {
    this.dirs.add(p);
  }
  async list(p: string) {
    const out: { path: string; isDir: boolean }[] = [];
    for (const dir of this.dirs) if (dir !== p && path.dirname(dir) === p) out.push({ path: dir, isDir: true });
    for (const file of this.files.keys()) if (path.dirname(file) === p) out.push({ path: file, isDir: false });
    return out;
  }
}

describe("SessionStaging", () => {
  let root: string;
  let remote: MemoryRemoteFs;
  let staging: SessionStaging;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "docslurp-modal-staging-"));
    remote = new MemoryRemoteFs();
    staging = new SessionStaging(remote);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uploads the same path only once per session", async () => {
    const file = path.join(root, "a.txt");
    writeFileSync(file, "hello");
    await staging.ensureUploaded([file]);
    await staging.ensureUploaded([file, file]);
    expect(remote.writes).toEqual([file]);
    expect(Buffer.from(remote.files.get(file)!).toString()).toBe("hello");
  });

  it("uploads directories recursively at the same absolute path", async () => {
    mkdirSync(path.join(root, "in", "nested"), { recursive: true });
    writeFileSync(path.join(root, "in", "one.txt"), "1");
    writeFileSync(path.join(root, "in", "nested", "two.txt"), "2");
    await staging.ensureUploaded([path.join(root, "in")]);
    expect([...remote.files.keys()].sort()).toEqual([
      path.join(root, "in", "nested", "two.txt"),
      path.join(root, "in", "one.txt"),
    ]);
    await staging.ensureUploaded([path.join(root, "in", "one.txt")]);
    expect(remote.writes).toHaveLength(2);
  });

  it("skips local paths that do not exist", async () => {
    await staging.ensureUploaded([path.join(root, "missing")]);
    expect(remote.writes).toEqual([]);
  });

  it("downloads nothing, without throwing, for a writable path the command never created", async () => {
    const target = path.join(root, "never-created");
    await expect(staging.download([target])).resolves.toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });

  it("downloads a remote file", async () => {
    const target = path.join(root, "out", "result.txt");
    remote.dirs.add(path.join(root, "out"));
    remote.files.set(target, Buffer.from("done"));
    await staging.download([target]);
    expect(readFileSync(target, "utf8")).toBe("done");
  });

  it("recreates a remote directory tree locally", async () => {
    const dir = path.join(root, "out");
    remote.dirs.add(dir);
    remote.dirs.add(path.join(dir, "sub"));
    remote.files.set(path.join(dir, "a.txt"), Buffer.from("a"));
    remote.files.set(path.join(dir, "sub", "b.txt"), Buffer.from("b"));
    await staging.download([dir]);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a");
    expect(readFileSync(path.join(dir, "sub", "b.txt"), "utf8")).toBe("b");
  });
});

describe("modal provider secrets", () => {
  const secret = "as-super-secret-value-123";
  const config = {
    tokenId: "ak-id",
    tokenSecret: secret,
    app: "app",
    image: "debian:trixie-slim",
    cpu: 1,
    memoryMb: 512,
    sessionTimeoutSeconds: 60,
  };

  function sdkRejecting(): ModalSdk {
    return {
      ModalClient: class {
        constructor() {
          throw new Error(`auth failed for token ${secret}`);
        }
      },
    } as unknown as ModalSdk;
  }

  it("never puts the token secret in a probe failure detail", async () => {
    const provider = createModalProvider(async () => sdkRejecting());
    const result = await provider.probe(config);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(secret);
  });

  it("never puts the token secret in an openSession error", async () => {
    const provider = createModalProvider(async () => sdkRejecting());
    const error = await provider.openSession(config, { activityId: "a" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(secret);
  });

  it("rejects a wrong-typed secret without echoing it", async () => {
    const provider = createModalProvider(async () => sdkRejecting());
    const bad = { ...config, tokenSecret: { nested: secret } as unknown as string };
    const error = await provider.openSession(bad, { activityId: "a" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxConfigError);
    expect(JSON.stringify((error as Error).message)).not.toContain(secret);
  });

  it("reports a missing package as a probe failure, not a crash", async () => {
    const provider = createModalProvider(async () => {
      throw new Error("Cannot find package 'modal'");
    });
    const result = await provider.probe(config);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("modal package not installed");
  });
});
