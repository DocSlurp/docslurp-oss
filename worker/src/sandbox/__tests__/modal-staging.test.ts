import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRunner, resolveVenvBin } from "../../tools/runner.js";
import { resolveScriptsDir } from "../../tools/scripts-dir.js";
import { buildModalUsageEvent, createModalProvider, type ModalSdk } from "../providers/modal/index.js";
import { SessionStaging, type RemoteFs } from "../providers/modal/staging.js";
import { SandboxConfigError, SandboxRunError } from "../types.js";

/** In-memory remote filesystem; every write gets a fresh mtime so changes are always visible. */
class MemoryRemoteFs implements RemoteFs {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  dirs = new Set<string>(["/"]);
  writes: string[] = [];
  reads: string[] = [];
  removed: string[] = [];
  private clock = 0;

  put(p: string, data: string) {
    for (let dir = path.dirname(p); !this.dirs.has(dir); dir = path.dirname(dir)) this.dirs.add(dir);
    this.files.set(p, { data: Buffer.from(data), mtime: ++this.clock });
  }
  async stat(p: string) {
    const file = this.files.get(p);
    if (file) return { path: p, isDir: false, size: file.data.length, mtime: file.mtime };
    return this.dirs.has(p) ? { path: p, isDir: true, size: 0, mtime: 0 } : null;
  }
  async writeFile(p: string, data: Uint8Array) {
    this.writes.push(p);
    this.files.set(p, { data, mtime: ++this.clock });
  }
  async readFile(p: string) {
    this.reads.push(p);
    const file = this.files.get(p);
    if (!file) throw new Error(`ENOENT ${p}`);
    return file.data;
  }
  async mkdir(p: string) {
    for (let dir = p; !this.dirs.has(dir); dir = path.dirname(dir)) this.dirs.add(dir);
  }
  async remove(p: string) {
    this.removed.push(p);
    const under = (q: string) => q === p || q.startsWith(`${p}/`);
    for (const file of [...this.files.keys()]) if (under(file)) this.files.delete(file);
    for (const dir of [...this.dirs]) if (under(dir)) this.dirs.delete(dir);
  }
  async list(p: string) {
    const out = [];
    for (const dir of this.dirs) if (dir !== p && path.dirname(dir) === p) out.push((await this.stat(dir))!);
    for (const file of this.files.keys()) if (path.dirname(file) === p) out.push((await this.stat(file))!);
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
    expect(Buffer.from(remote.files.get(file)!.data).toString()).toBe("hello");
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
    const snapshot = await staging.snapshot([target]);
    await expect(staging.download(snapshot)).resolves.toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });

  it("downloads a file the command created", async () => {
    const dir = path.join(root, "out");
    const snapshot = await staging.snapshot([dir]);
    remote.put(path.join(dir, "result.txt"), "done");
    await staging.download(snapshot);
    expect(readFileSync(path.join(dir, "result.txt"), "utf8")).toBe("done");
  });

  it("recreates a directory tree the command created", async () => {
    const dir = path.join(root, "out");
    await remote.mkdir(dir);
    const snapshot = await staging.snapshot([dir]);
    await remote.mkdir(path.join(dir, "empty"));
    remote.put(path.join(dir, "a.txt"), "a");
    remote.put(path.join(dir, "sub", "b.txt"), "b");
    await staging.download(snapshot);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("a");
    expect(readFileSync(path.join(dir, "sub", "b.txt"), "utf8")).toBe("b");
    expect(existsSync(path.join(dir, "empty"))).toBe(true);
  });

  it("downloads only files created or changed since the snapshot, never inputs or earlier files", async () => {
    const dir = path.join(root, "work");
    mkdirSync(dir);
    const input = path.join(dir, "input.txt");
    writeFileSync(input, "local input");
    await staging.ensureUploaded([input]);
    remote.put(path.join(dir, "earlier.txt"), "from an earlier command");
    remote.put(path.join(dir, "rewritten.txt"), "old");
    const snapshot = await staging.snapshot([dir]);
    remote.put(path.join(dir, "rewritten.txt"), "new");
    remote.put(path.join(dir, "out.txt"), "output");
    // The host changed its copy of the input meanwhile; a download must not overwrite it.
    writeFileSync(input, "host edit");
    await staging.download(snapshot);
    expect(remote.reads.sort()).toEqual([path.join(dir, "out.txt"), path.join(dir, "rewritten.txt")]);
    expect(readFileSync(input, "utf8")).toBe("host edit");
    expect(existsSync(path.join(dir, "earlier.txt"))).toBe(false);
    expect(readFileSync(path.join(dir, "rewritten.txt"), "utf8")).toBe("new");
  });

  it("discards a command's new and modified paths and re-uploads a modified input on next use", async () => {
    const dir = path.join(root, "work");
    mkdirSync(dir);
    const input = path.join(dir, "input.txt");
    writeFileSync(input, "input");
    await staging.ensureUploaded([input]);
    remote.put(path.join(dir, "earlier.txt"), "kept");
    const snapshot = await staging.snapshot([dir]);
    remote.put(path.join(dir, "partial.txt"), "partial");
    remote.put(path.join(dir, "pages", "1.png"), "png");
    remote.put(input, "clobbered");

    const removed = await staging.discard(snapshot);
    expect(removed.sort()).toEqual([input, path.join(dir, "pages"), path.join(dir, "partial.txt")]);
    expect([...remote.files.keys()]).toEqual([path.join(dir, "earlier.txt")]);
    expect(remote.dirs.has(dir)).toBe(true);

    await staging.ensureUploaded([input]);
    expect(Buffer.from(remote.files.get(input)!.data).toString()).toBe("input");
  });

  it("never copies back an input uploaded for another command after the snapshot", async () => {
    const dir = path.join(root, "work");
    mkdirSync(dir);
    const snapshot = await staging.snapshot([dir]);
    const otherInput = path.join(dir, "other-input.txt");
    writeFileSync(otherInput, "input");
    await staging.ensureUploaded([otherInput]);
    // The host replaces its copy; a download must not overwrite it with the uploaded one.
    writeFileSync(otherInput, "host edit");
    remote.put(path.join(dir, "out.txt"), "output");
    await staging.download(snapshot);
    expect(remote.reads).toEqual([path.join(dir, "out.txt")]);
    expect(readFileSync(otherInput, "utf8")).toBe("host edit");
  });

  it("does not discard paths a later upload or download put there", async () => {
    const dir = path.join(root, "work");
    await remote.mkdir(dir);
    const aborted = await staging.snapshot([dir]);
    const other = await staging.snapshot([dir]);
    remote.put(path.join(dir, "other.txt"), "finished output");
    await staging.download(other);
    const laterInput = path.join(dir, "later-input.txt");
    writeFileSync(laterInput, "input");
    await staging.ensureUploaded([laterInput]);
    remote.put(path.join(dir, "partial.txt"), "partial");

    expect(await staging.discard(aborted)).toEqual([path.join(dir, "partial.txt")]);
    expect([...remote.files.keys()].sort()).toEqual([laterInput, path.join(dir, "other.txt")]);
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

const lifecycleConfig = {
  tokenId: "ak-id",
  tokenSecret: "as-secret",
  app: "app",
  image: "debian:trixie-slim",
  cpu: 1,
  memoryMb: 512,
  sessionTimeoutSeconds: 60,
};

class NotFound extends Error {}

type FakeProcess = { stdout: { readText(): Promise<string> }; stderr: { readText(): Promise<string> }; wait(): Promise<number> };

function finished(stdout = "out", exitCode = 0): FakeProcess {
  return { stdout: { readText: async () => stdout }, stderr: { readText: async () => "" }, wait: async () => exitCode };
}

/** A process that runs until the test's kill handler (or the test) ends it. */
function running(): { process: FakeProcess; end(exitCode: number): void } {
  let end!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => (end = resolve));
  const process = { stdout: { readText: async () => (await exited, "") }, stderr: { readText: async () => (await exited, "") }, wait: () => exited };
  return { process, end };
}

/** The provider launches commands as [sh, -c, launch, sh, start, control, binary, ...args] and kills as [sh, -c, kill, sh, control]. */
const isKill = (argv: string[]) => argv.length === 5;
const controlOf = (argv: string[]) => (isKill(argv) ? argv[4] : argv[5]);

/**
 * A Modal SDK double: an in-memory sandbox filesystem plus a scripted `exec`. Each test
 * scripts the parser command (`exec` gets the command's own argv); kills are recorded and
 * passed to `onKill` with the control path of the command being killed.
 */
function fakeSdk(
  opts: {
    createFails?: boolean;
    exec?: (command: string[], control: string) => Promise<FakeProcess>;
    onKill?: (control: string) => void;
  } = {},
) {
  const remote = new MemoryRemoteFs();
  const state = {
    terminate: 0,
    clientClose: 0,
    mkdirs: [] as string[],
    stats: [] as string[],
    images: [] as Array<[string, unknown]>,
    commands: [] as string[][],
    commandTimeouts: [] as Array<number | undefined>,
    kills: [] as string[],
    remote,
  };
  const info = (entry: { path: string; isDir: boolean; size: number; mtime: number }) => ({
    path: entry.path,
    type: entry.isDir ? "directory" : "file",
    size: entry.size,
    modifiedTime: entry.mtime,
  });
  const sandbox = {
    terminate: async () => void state.terminate++,
    filesystem: {
      makeDirectory: async (p: string) => {
        state.mkdirs.push(p);
        await remote.mkdir(p);
      },
      writeBytes: (data: Uint8Array, p: string) => remote.writeFile(p, data),
      readBytes: (p: string) => remote.readFile(p),
      remove: (p: string) => remote.remove(p),
      stat: async (p: string) => {
        state.stats.push(p);
        const entry = await remote.stat(p);
        if (!entry) throw new NotFound();
        return info(entry);
      },
      listFiles: async (p: string) => (await remote.list(p)).map(info),
    },
    exec: async (argv: string[], params?: { timeoutMs?: number }) => {
      if (isKill(argv)) {
        state.kills.push(controlOf(argv));
        opts.onKill?.(controlOf(argv));
        return finished("", 0);
      }
      state.commands.push(argv.slice(6));
      state.commandTimeouts.push(params?.timeoutMs);
      return (opts.exec ?? (async () => finished()))(argv.slice(6), controlOf(argv));
    },
  };
  const sdk = {
    SandboxFilesystemNotFoundError: NotFound,
    ModalClient: class {
      apps = { fromName: async () => ({}) };
      images = { fromRegistry: (tag: string, secret?: unknown) => void state.images.push([tag, secret]) };
      secrets = { fromName: async (name: string) => ({ secret: name }) };
      sandboxes = {
        create: async () => {
          if (opts.createFails) throw new Error("no capacity");
          return sandbox;
        },
      };
      close() {
        state.clientClose++;
      }
    },
  } as unknown as ModalSdk;
  return { sdk, state };
}

describe("modal provider session lifecycle", () => {
  const config = lifecycleConfig;
  const command = {
    binary: "/usr/bin/true",
    args: [],
    env: {},
    readablePaths: [],
    inputPaths: [],
    writablePaths: [],
    limits: { timeoutMs: 5_000 },
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  async function open(opts: Parameters<typeof fakeSdk>[0] = {}) {
    const { sdk, state } = fakeSdk(opts);
    const provider = createModalProvider(async () => sdk);
    return { state, provider, session: () => provider.openSession(config, { activityId: "a" }) };
  }

  it("close terminates the sandbox once and is idempotent", async () => {
    const { state, session } = await open();
    const opened = await session();
    await opened.close();
    await opened.close();
    expect(state.terminate).toBe(1);
    expect(state.clientClose).toBe(1);
  });

  /** Usage lines logged for this test's commands. */
  function usageLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[sandbox-usage]"));
  }

  it("aborting a command kills its process group and rejects only that command", async () => {
    const processes = new Map<string, ReturnType<typeof running>>();
    let calls = 0;
    const { state, session } = await open({
      exec: async (_command, control) => {
        if (++calls > 1) return finished("second");
        const proc = running();
        processes.set(control, proc);
        return proc.process;
      },
      onKill: (control) => processes.get(control)?.end(137),
    });
    const opened = await session();
    const controller = new AbortController();
    const running1 = opened.run!(command, controller.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(processes.size).toBe(1));
    controller.abort();
    const error = await running1;
    expect(error).toBeInstanceOf(SandboxRunError);
    expect((error as Error).message).toBe("modal sandbox command aborted");
    expect(state.kills).toEqual([...processes.keys()]);
    expect(state.terminate).toBe(0);
    // Usage is recorded exactly once for the aborted command.
    expect((error as SandboxRunError).usage?.provider).toBe("modal");
    expect(usageLines()).toHaveLength(1);

    const next = await opened.run!(command);
    expect(next.stdout).toBe("second");
    expect(usageLines()).toHaveLength(2);
    await opened.close();
    expect(state.terminate).toBe(1);
  });

  it("starts no remote process when the abort lands while inputs are staging", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-abort-"));
    try {
      const input = path.join(dir, "input.pdf");
      writeFileSync(input, "%PDF");
      const { state, session } = await open();
      const opened = await session();
      const controller = new AbortController();
      const write = state.remote.writeFile.bind(state.remote);
      state.remote.writeFile = async (p, data) => {
        controller.abort();
        await write(p, data);
      };
      const error = await opened.run!({ ...command, inputPaths: [input], writablePaths: [dir] }, controller.signal).catch(
        (e: unknown) => e,
      );
      expect((error as Error).message).toBe("modal sandbox command aborted");
      expect(state.commands).toEqual([]);
      expect(state.kills).toEqual([]);
      expect(usageLines()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes an aborted command's partial output remotely and never downloads it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-abort-"));
    try {
      const partial = path.join(dir, "partial.json");
      const processes = new Map<string, ReturnType<typeof running>>();
      const { state, session } = await open({
        exec: async ([binary], control) => {
          if (binary === "partial") {
            state.remote.put(partial, "{\"incomplete\":");
            const proc = running();
            processes.set(control, proc);
            return proc.process;
          }
          state.remote.put(path.join(dir, "ok.json"), "{}");
          return finished();
        },
        // Killing stops the process; it writes nothing after the kill.
        onKill: (control) => processes.get(control)?.end(137),
      });
      const opened = await session();
      const controller = new AbortController();
      const aborted = opened.run!({ ...command, binary: "partial", writablePaths: [dir] }, controller.signal).catch(
        (e: unknown) => e,
      );
      await vi.waitFor(() => expect(processes.size).toBe(1));
      controller.abort();
      expect((await aborted) as Error).toBeInstanceOf(SandboxRunError);
      expect(state.remote.files.has(partial)).toBe(false);
      expect(existsSync(partial)).toBe(false);

      await opened.run!({ ...command, binary: "ok", writablePaths: [dir] });
      expect(readFileSync(path.join(dir, "ok.json"), "utf8")).toBe("{}");
      expect(existsSync(partial)).toBe(false);
      await opened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a timed-out command and discards its partial output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-timeout-"));
    try {
      const partial = path.join(dir, "partial.json");
      const { state, session } = await open({
        exec: async () => {
          state.remote.put(partial, "{");
          throw new Error("Deadline exceeded while streaming stdio for exec x");
        },
      });
      const opened = await session();
      const result = await opened.run!({ ...command, writablePaths: [dir] });
      expect(result.exitCode).toBeNull();
      expect(state.kills).toHaveLength(1);
      expect(state.remote.files.has(partial)).toBe(false);
      expect(existsSync(partial)).toBe(false);
      expect(usageLines()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers removing an aborted command's changes until concurrent commands finish", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-concurrent-"));
    try {
      const processes = new Map<string, ReturnType<typeof running>>();
      const { state, session } = await open({
        exec: async ([binary], control) => {
          const proc = running();
          processes.set(binary, proc);
          state.remote.put(path.join(dir, `${binary}.json`), binary === "slow" ? "{\"in-progress\":" : "{");
          return proc.process;
        },
        onKill: () => processes.get("aborted")?.end(137),
      });
      const opened = await session();
      const controller = new AbortController();
      const aborted = opened.run!({ ...command, binary: "aborted", writablePaths: [dir] }, controller.signal).catch(
        (e: unknown) => e,
      );
      await vi.waitFor(() => expect(processes.has("aborted")).toBe(true));
      const slow = opened.run!({ ...command, binary: "slow", writablePaths: [dir] });
      await vi.waitFor(() => expect(processes.has("slow")).toBe(true));
      controller.abort();
      expect((await aborted) as Error).toBeInstanceOf(SandboxRunError);
      // The slow command is still writing slow.json, which the aborted command's snapshot
      // cannot tell apart from its own output; nothing may be removed yet.
      expect(state.remote.removed).toEqual([]);

      state.remote.put(path.join(dir, "slow.json"), "{\"done\":true}");
      processes.get("slow")!.end(0);
      await slow;
      expect(readFileSync(path.join(dir, "slow.json"), "utf8")).toBe("{\"done\":true}");
      expect(state.remote.removed).toEqual([path.join(dir, "aborted.json")]);
      expect(state.remote.files.has(path.join(dir, "slow.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an exec error caused by an abort while the exec starts as an abort", async () => {
    const controller = new AbortController();
    const { state, session } = await open({
      exec: async () => {
        controller.abort();
        throw new Error("stream reset while starting exec");
      },
    });
    const opened = await session();
    const error = await opened.run!(command, controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxRunError);
    expect((error as Error).message).toBe("modal sandbox command aborted");
    expect(state.kills).toHaveLength(1);
    expect(usageLines()).toHaveLength(1);
  });

  it("drops pending removals once the session is closed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-closed-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const processes = new Map<string, ReturnType<typeof running>>();
      const { state, session } = await open({
        exec: async ([binary]) => {
          const proc = running();
          processes.set(binary, proc);
          state.remote.put(path.join(dir, `${binary}.json`), "{");
          return proc.process;
        },
        onKill: () => processes.get("aborted")?.end(137),
      });
      const opened = await session();
      const controller = new AbortController();
      const aborted = opened.run!({ ...command, binary: "aborted", writablePaths: [dir] }, controller.signal).catch(
        (e: unknown) => e,
      );
      await vi.waitFor(() => expect(processes.has("aborted")).toBe(true));
      const slow = opened.run!({ ...command, binary: "slow", writablePaths: [dir] }).catch((e: unknown) => e);
      await vi.waitFor(() => expect(processes.has("slow")).toBe(true));
      controller.abort();
      await aborted;
      await opened.close();
      processes.get("slow")!.end(0);
      await slow;
      expect(state.remote.removed).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an already-aborted command without terminating the session", async () => {
    const { state, session } = await open();
    const opened = await session();
    const error = await opened.run!(command, AbortSignal.abort()).catch((e: unknown) => e);
    expect((error as Error).message).toContain("aborted");
    expect(state.terminate).toBe(0);
    await expect(opened.run!(command)).resolves.toMatchObject({ exitCode: 0 });
  });

  it("terminates and releases the client when sandbox creation fails", async () => {
    const { state, session } = await open({ createFails: true });
    await expect(session()).rejects.toThrow("modal sandbox creation failed");
    expect(state.clientClose).toBe(1);
  });

  it("rethrows a non-timeout exec error instead of reporting a timeout", async () => {
    const { session } = await open({
      exec: async () => {
        throw new Error("container crashed");
      },
    });
    const opened = await session();
    await expect(opened.run!(command)).rejects.toThrow("container crashed");
  });

  it("returns the command's provider cost as a usage event, and attaches it to failures", async () => {
    const { session } = await open();
    const opened = await session();
    const result = await opened.run!(command);
    expect(result.usage).toMatchObject({ provider: "modal", metric: "sandbox_compute", costCents: 0 });

    const failing = await open({
      exec: async () => {
        throw new Error("container crashed");
      },
    });
    const error = await (await failing.session()).run!(command).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxRunError);
    expect((error as SandboxRunError).usage?.provider).toBe("modal");
  });

  it("pulls the image with the named registry secret when one is configured", async () => {
    const { sdk, state } = fakeSdk();
    const provider = createModalProvider(async () => sdk);
    await (await provider.openSession({ ...config, registrySecret: "ghcr-pull" }, { activityId: "a" })).close();
    await (await provider.openSession(config, { activityId: "b" })).close();
    expect(state.images).toEqual([
      ["debian:trixie-slim", { secret: "ghcr-pull" }],
      ["debian:trixie-slim", undefined],
    ]);
  });

  it("rounds a command's time limit up to the whole seconds Modal accepts", async () => {
    const { state, session } = await open();
    const opened = await session();
    await opened.run!({ ...command, limits: { timeoutMs: 1_500 } });
    await opened.run!({ ...command, limits: { timeoutMs: 30_000 } });
    expect(state.commandTimeouts).toEqual([2_000, 30_000]);
  });

  it("reports an exec deadline as a killed command", async () => {
    const { session } = await open({
      exec: async () => {
        throw new Error("Deadline exceeded while streaming stdio for exec x");
      },
    });
    const opened = await session();
    const result = await opened.run!(command);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("time limit");
  });
});

describe("CommandRunner through the modal provider", () => {
  let workspace: string;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    workspace = mkdtempSync(path.join(tmpdir(), "docslurp-modal-runner-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("stages only the command's input file, never the host runtime", async () => {
    const { sdk, state } = fakeSdk();
    const provider = createModalProvider(async () => sdk);
    const runner = new CommandRunner({
      openSession: (activityId) => provider.openSession(lifecycleConfig, { activityId }),
    });
    const input = path.join(workspace, "source.pdf");
    writeFileSync(input, "%PDF-1.7");
    const output = path.join(workspace, "source.pdf.md");
    const script = path.join(resolveScriptsDir(), "pdf_extract.py");
    const venvPython = path.join(resolveVenvBin(process.env.PYTHON_VENV), "python3");

    await runner.run({ binary: venvPython, args: [script, "--input", input, "--output", output], available: true });

    expect(state.remote.writes).toEqual([input]);
    expect(state.mkdirs).toEqual(["/tmp/.docslurp-modal-control", workspace]);
    const staged = [...state.remote.writes, ...state.mkdirs.slice(1)].join("\n");
    for (const host of ["node_modules", ".venv", process.execPath, resolveScriptsDir()]) expect(staged).not.toContain(host);
    expect(staged.split("\n").some((p) => p === "/usr" || p.startsWith("/usr/"))).toBe(false);
  });
});

describe("modal usage event", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is provider cost only, never customer credits, even with compute billing on", () => {
    vi.stubEnv("DOCSLURP_BILL_COMPUTE", "true");
    const event = buildModalUsageEvent(lifecycleConfig, "activity-1", 10);
    expect(event.provider).toBe("modal");
    expect(event.costCents).toBe(0);
    expect(event.metadata).toMatchObject({ costRollup: "included", billable: false, activityId: "activity-1" });
    expect(Number(event.metadata?.effectiveCostCents)).toBeGreaterThan(0);
  });
});

describe("modal image default", () => {
  const provider = createModalProvider(async () => {
    throw new Error("not loaded");
  });
  const tokens = { MODAL_TOKEN_ID: "ak-id", MODAL_TOKEN_SECRET: "as-secret" };

  it("defaults to the worker-full image of the release the worker image was built from", () => {
    expect(provider.readConfig({ ...tokens, DOCSLURP_VERSION: "1.2.3" }).image).toBe("ghcr.io/docslurp/worker-full:1.2.3");
  });

  it("uses DOCSLURP_MODAL_IMAGE when set", () => {
    expect(provider.readConfig({ ...tokens, DOCSLURP_VERSION: "1.2.3", DOCSLURP_MODAL_IMAGE: "example/parsers:1" }).image).toBe(
      "example/parsers:1",
    );
  });

  it("requires DOCSLURP_MODAL_IMAGE when DOCSLURP_VERSION is unset", () => {
    const read = () => provider.readConfig({ ...tokens });
    expect(read).toThrow(SandboxConfigError);
    expect(read).toThrow(/DOCSLURP_MODAL_IMAGE.*DOCSLURP_VERSION is unset/);
  });
});
