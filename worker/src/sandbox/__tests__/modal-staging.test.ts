import { pricing } from "@docslurp/shared";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRunner, resolveVenvBin } from "../../tools/runner.js";
import { resolveScriptsDir } from "../../tools/scripts-dir.js";
import { buildModalUsageEvent, createModalProvider, modalVmIdleSeconds, modalVmsPerActivity, modalVmsPerWorker, type ModalSdk } from "../providers/modal/index.js";
import { SessionStaging, type RemoteFs } from "../providers/modal/staging.js";
import { SandboxConfigError, SandboxInfrastructureError, SandboxOutputError, SandboxRunError } from "../types.js";

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

  it("refreshes a reused input path when its contents change, including same-size edits", async () => {
    const file = path.join(root, "a.txt");
    writeFileSync(file, "first"); await staging.ensureUploaded([file]);
    writeFileSync(file, "other"); await staging.ensureUploaded([file]);
    expect(remote.writes).toEqual([file, file]);
    expect(Buffer.from(remote.files.get(file)!.data).toString()).toBe("other");
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

type FakeProcess = { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; wait(): Promise<number> };
function stream(text: string | Uint8Array): ReadableStream<Uint8Array> { return new ReadableStream({ start(c) { c.enqueue(typeof text === "string" ? Buffer.from(text) : text); c.close(); } }); }
function finished(stdout = "out", exitCode = 0): FakeProcess { return { stdout: stream(stdout), stderr: stream(""), wait: async () => exitCode }; }
function running(): { process: FakeProcess; end(exitCode: number): void } {
  let end!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => (end = resolve));
  const pending = () => new ReadableStream<Uint8Array>({ async start(c) { await exited; c.close(); } });
  return { process: { stdout: pending(), stderr: pending(), wait: () => exited }, end };
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
    createGate?: Promise<void>;
    exec?: (command: string[], control: string, vm: number) => Promise<FakeProcess>;
    onKill?: (control: string) => void;
    /** VM creation (the nth create and later) fails. */
    createFailsFrom?: number;
    /** The leftover kill fails only in this VM. */
    killFailsInVm?: number;
    /** The post-command reset finds the VM's disk or job roots unusable (exit 5) in this VM. */
    resetUnhealthyInVm?: number;
    /** The VM-start image lock finds paths the parser user can write (exit 6). */
    lockFails?: boolean;
    /** The leftover kill exec throws: a deadline (held up inside the VM) or a transport error. */
    killThrows?: "deadline" | "transport";
    /** The app lookup before each create takes this long (a slow Modal API). */
    lookupDelayMs?: number;
    /** Directory creation in job trees exits non-zero (a job broke the tree). */
    mkdirFails?: boolean | (() => boolean);
    /** The first client's terminate request never answers (a stuck connection). */
    terminateHangs?: boolean;
    /** Terminate requests wait on this (a slow acknowledgement). */
    terminateGate?: Promise<void>;
    /** Every terminate request fails, the late retry on a fresh client too. */
    terminateFails?: boolean;
    /** The VM's link hardening fails (a sysctl that cannot be written or reads back 0). */
    hardeningFails?: boolean;
    /** The leftover kill waits on this (a slow kill). */
    killGate?: Promise<void>;
    /** The leftover kill leaves a parser-user process alive (exit 4). */
    killFails?: boolean;
  } = {},
) {
  const remote = new MemoryRemoteFs();
  const state = {
    terminate: 0,
    lateTerminate: 0,
    hardened: 0,
    readsAsUser: 0,
    leftoverKills: 0,
    locks: 0,
    resets: [] as Array<{ vm: number; roots: string[] }>,
    rootWrites: [] as string[],
    events: [] as string[],
    clientClose: 0,
    mkdirs: [] as string[],
    stats: [] as string[],
    images: [] as Array<[string, unknown]>,
    commands: [] as string[][],
    commandTimeouts: [] as Array<number | undefined>,
    kills: [] as string[],
    createOptions: [] as unknown[],
    /** Which VM ran each parser command, in start order. */
    commandVms: [] as number[],
    commandEnvs: [] as Array<Record<string, string>>,
    chmods: [] as string[][],
    /** When each VM was created and terminated (index = VM number - 1). */
    createdAt: [] as number[],
    terminatedAt: [] as number[],
    remote,
  };
  const info = (entry: { path: string; isDir: boolean; size: number; mtime: number }) => ({
    path: entry.path,
    type: entry.isDir ? "directory" : "file",
    size: entry.size,
    modifiedTime: entry.mtime,
  });
  const sandbox = {
    sandboxId: "sb-test",
    terminate: async () => {
      state.terminate++;
      if (opts.terminateHangs) await new Promise(() => {});
      await opts.terminateGate;
      if (opts.terminateFails) throw new Error("terminate refused");
    },
    filesystem: {
      // Root's filesystem API: recorded, so a test can require that root writes only its own control directory.
      makeDirectory: async (p: string) => {
        state.mkdirs.push(p);
        state.rootWrites.push(p);
        await remote.mkdir(p);
      },
      writeBytes: (data: Uint8Array, p: string) => { state.rootWrites.push(p); return remote.writeFile(p, data); },
      readBytes: (p: string) => remote.readFile(p),
      remove: (p: string) => { state.rootWrites.push(p); return remote.remove(p); },
      stat: async (p: string) => {
        state.stats.push(p);
        const entry = await remote.stat(p);
        if (!entry) throw new NotFound();
        return info(entry);
      },
      listFiles: async (p: string) => (await remote.list(p)).map(info),
    },
    exec: async (argv: string[], params?: { timeoutMs?: number }, vm = 1) => {
      if (argv[0] === "/bin/sh" && argv[2]?.includes("protected_hardlinks")) { state.hardened++; return finished("", opts.hardeningFails ? 3 : 0); }
      // Readback and listing run as the parser user (setpriv prefix): record it, then serve them.
      const asUser = argv[0] === "/usr/bin/setpriv" && argv.includes("--reuid=10001") ? argv.slice(argv.indexOf("--") + 1) : null;
      if (asUser?.[0] === "/bin/cat") {
        state.readsAsUser++;
        // cat exits 1 on a file it cannot read (EACCES, a fifo the job left).
        const data = await remote.readFile(asUser[2]!).catch(() => null);
        return data ? { stdout: stream(data), stderr: stream(""), wait: async () => 0 } : finished("", 1);
      }
      if (asUser?.[0] === "python3" && asUser[1] === "-I") return finished((await remote.list(asUser[4]!)).map((entry) => JSON.stringify(entry)).join("\n"));
      // Staging in job trees, as the parser user (council M #3).
      if (asUser?.[0] === "/bin/mkdir") { if (typeof opts.mkdirFails === "function" ? opts.mkdirFails() : opts.mkdirFails) return finished("", 1); state.mkdirs.push(asUser[3]!); await remote.mkdir(asUser[3]!); return finished("", 0); }
      if (asUser?.[0] === "/bin/rm") { await remote.remove(asUser[3]!); return finished("", 0); }
      if (asUser?.[0] === "/bin/sh" && asUser[2]?.includes("cp --")) { await remote.writeFile(asUser[5]!, await remote.readFile(asUser[4]!)); return finished("", 0); }
      // VM start: the image lock and writable check (council W #1).
      if (argv[0] === "python3" && argv[3]?.startsWith("# docslurp-image-lock")) { state.locks++; return finished("", opts.lockFails ? 6 : 0); }
      // After every command: the root wipe of the parser user's scratch and the health check (council W #1, U #8).
      if (argv[0] === "python3" && argv[3]?.startsWith("# docslurp-reset")) {
        state.resets.push({ vm, roots: argv.slice(4) });
        state.events.push("reset");
        return finished("", opts.resetUnhealthyInVm === vm ? 5 : 0);
      }
      // The root leftover kill (KILL_PARSER_USER_ARGV): kill(-1) as the parser user, verified.
      if (argv[0] === "python3" && argv[3]?.includes("os.kill(-1")) {
        state.leftoverKills++;
        state.events.push("kill-start");
        await opts.killGate;
        state.events.push("kill-end");
        if (opts.killThrows === "deadline") throw new Error("Deadline exceeded while waiting for the exec");
        if (opts.killThrows === "transport") throw new Error("stream reset by peer");
        return finished("", opts.killFails || opts.killFailsInVm === vm ? 4 : 0);
      }
      if (argv[0] === "/bin/chmod") { state.chmods.push(argv.slice(1)); return finished("", 0); }
      if (argv[0] === "/bin/cat" || argv[0] === "python3") throw new Error("root must never read or list job output");
      if (isKill(argv)) {
        state.kills.push(controlOf(argv));
        opts.onKill?.(controlOf(argv));
        return finished("", 0);
      }
      const command = argv.slice(7 + Number(argv[6]));
      state.commands.push(command);
      state.events.push(`exec:${command.join(" ")}`);
      state.commandTimeouts.push(params?.timeoutMs);
      state.commandVms.push(vm);
      state.commandEnvs.push((params as { env?: Record<string, string> } | undefined)?.env ?? {});
      return (opts.exec ?? (async () => finished()))(command, controlOf(argv), vm);
    },
  };
  const sdk = {
    SandboxFilesystemNotFoundError: NotFound,
    Sandbox: class { constructor(_client: unknown, _id: string) {} async terminate() { state.terminate++; state.lateTerminate++; if (opts.terminateFails) throw new Error("terminate refused"); } },
    ModalClient: class {
      apps = { fromName: async () => { if (opts.lookupDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.lookupDelayMs)); return {}; } };
      images = { fromRegistry: (tag: string, secret?: unknown) => void state.images.push([tag, secret]) };
      secrets = { fromName: async (name: string) => ({ secret: name }) };
      sandboxes = {
        create: async (_app: unknown, _image: unknown, options: unknown) => {
          state.createOptions.push(options);
          await opts.createGate;
          if (opts.createFails) throw new Error("no capacity");
          const vm = state.createOptions.length;
          if (opts.createFailsFrom !== undefined && vm >= opts.createFailsFrom) throw new Error("no capacity");
          state.createdAt[vm - 1] = Date.now();
          return { ...sandbox, sandboxId: `sb-${vm}`, terminate: async () => { await sandbox.terminate(); state.terminatedAt[vm - 1] = Date.now(); }, exec: (argv: string[], params?: { timeoutMs?: number }) => sandbox.exec(argv, params, vm) };
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

  it("closes a creation deadline promptly and terminates a late VM with a fresh client", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const { state, session } = await open({ createGate: gate });
      const pending = session().catch((error: unknown) => error);
      // The 30 s creation deadline, then up to 5 s for the create call to settle before its capacity is quarantined
      // (recheck T #1).
      await vi.advanceTimersByTimeAsync(30_001);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toBeInstanceOf(Error);
      expect(state.clientClose).toBe(1);
      release(); await vi.advanceTimersByTimeAsync(1);
      expect(state.terminate).toBe(1); expect(state.clientClose).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("hardens kernel link protections once per VM, and reads job output only as the parser user (council K #5)", async () => {
    const { state, session } = await open({ exec: async () => finished() });
    const opened = await session();
    await opened.run!({ ...command, writablePaths: ["/job/out"] });
    await opened.close();
    expect(state.hardened).toBe(1);
  });

  it("root writes only its own control directory; job trees are staged as the parser user (council M #3)", async () => {
    const { state, session } = await open({ exec: async () => finished() });
    const opened = await session();
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-m3-"));
    try {
      const input = path.join(dir, "in.txt");
      await writeFile(input, "first");
      await opened.run!({ ...command, inputPaths: [input], writablePaths: [path.join(dir, "out")] });
      await writeFile(input, "second edit");
      await opened.run!({ ...command, inputPaths: [input], writablePaths: [path.join(dir, "out")] });
      expect(state.rootWrites.length).toBeGreaterThan(0);
      for (const target of state.rootWrites) expect(target.startsWith("/tmp/.docslurp-modal-control")).toBe(true);
      expect(Buffer.from(await state.remote.readFile(input)).toString()).toBe("second edit");
      // Leftover parser-user processes are killed after each command, before anything is read back or staged.
      expect(state.leftoverKills).toBeGreaterThanOrEqual(2);
    } finally {
      await opened.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("commands in a session run one at a time: a command arriving during a run or the leftover kill waits (council P #3, O #4)", async () => {
    let release!: () => void;
    const killGate = new Promise<void>((resolve) => { release = resolve; });
    const slow = running();
    let calls = 0;
    const { state, session } = await open({ killGate, exec: async () => (++calls === 1 ? slow.process : finished()) });
    const opened = await session();
    const first = opened.run!({ ...command, binary: "/bin/first" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = opened.run!({ ...command, binary: "/bin/second" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.events.some((event) => event.startsWith("exec:/bin/second"))).toBe(false); // not while the first runs
    slow.end(0);
    for (let i = 0; i < 50 && !state.events.includes("kill-start"); i++) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.events.some((event) => event.startsWith("exec:/bin/second"))).toBe(false); // nor during the kill
    release();
    await first;
    await second;
    const events = state.events.filter((event) => event === "kill-end" || event.startsWith("exec:"));
    expect(events.slice(0, 3)).toEqual(["exec:/bin/first", "kill-end", "exec:/bin/second"]);
    await opened.close();
  });

  it("a leftover kill that leaves a parser-user process alive fails that command's document and terminates its VM (council O #4, recheck S #2b)", async () => {
    const { state, session } = await open({ killFailsInVm: 1, exec: async () => finished() });
    const opened = await session();
    const failure = await opened.run!(command).catch((error: unknown) => error);
    // The survivors are the command's own processes: its document fails, once, rather than retrying the stage.
    expect(failure).toBeInstanceOf(SandboxOutputError);
    expect(failure).not.toBeInstanceOf(SandboxInfrastructureError);
    expect(String((failure as Error).message)).toMatch(/could not be killed; VM terminated/);
    expect(state.terminate).toBe(1);
    // That VM never runs another command: the next one gets a fresh VM, hardened like the first.
    await expect(opened.run!(command)).resolves.toMatchObject({ exitCode: 0 });
    expect(state.createOptions).toHaveLength(2);
    expect(state.commandVms).toEqual([1, 2]);
    expect(state.hardened).toBe(2);
    await opened.close();
  });

  it("a VM whose disk or job roots a command left unusable is that command's strike, never the next document's (council U #8)", async () => {
    const { state, session } = await open({ resetUnhealthyInVm: 1, exec: async () => finished() });
    const opened = await session();
    const failure = await opened.run!({ ...command, affinityKey: "doc-a" }).catch((error: unknown) => error);
    // Checked right after doc-a's own command, as part of the leftover kill, with the job roots to check.
    expect(failure).toBeInstanceOf(SandboxInfrastructureError);
    expect((failure as SandboxInfrastructureError).afterCommand).toBe(true);
    expect(String((failure as Error).message)).toMatch(/unusable after this document's command; VM terminated/);
    expect(state.resets[0]!.roots.length).toBeGreaterThan(0);
    expect(state.terminate).toBe(1);
    // doc-b runs on a fresh VM and never sees the broken one.
    await expect(opened.run!({ ...command, affinityKey: "doc-b" })).resolves.toMatchObject({ exitCode: 0 });
    expect(state.commandVms).toEqual([1, 2]);
    await opened.close();
  });

  it("each command gets its own HOME, temp and XDG directories outside its writable paths, wiped after it (council W #1)", async () => {
    const { state, session } = await open({ exec: async () => finished() });
    const opened = await session();
    await opened.run!({ ...command, affinityKey: "doc-a", env: { PATH: "/usr/bin", HOME: "/home/docslurp", TMPDIR: "/tmp" } });
    await opened.run!({ ...command, affinityKey: "doc-b" });
    const [first, second] = state.commandEnvs;
    const scratchOf = (env: Record<string, string>) => env.HOME!.replace(/\/home$/, "");
    for (const env of [first!, second!]) {
      const scratch = scratchOf(env);
      expect(scratch).toMatch(/^\/tmp\/docslurp-parser-sandbox\/\.cmd-\d+-\d+$/);
      expect(env).toMatchObject({ TMPDIR: `${scratch}/tmp`, TMP: `${scratch}/tmp`, TEMP: `${scratch}/tmp`, XDG_CACHE_HOME: `${scratch}/xdg/cache`, XDG_CONFIG_HOME: `${scratch}/xdg/config`, XDG_DATA_HOME: `${scratch}/xdg/data`, XDG_STATE_HOME: `${scratch}/xdg/state`, XDG_RUNTIME_DIR: `${scratch}/xdg/runtime` });
      for (const dir of [env.HOME!, env.TMPDIR!, env.XDG_RUNTIME_DIR!]) expect(state.mkdirs).toContain(dir);
      expect(command.writablePaths.some((w: string) => env.HOME!.startsWith(w))).toBe(false);
    }
    // The caller's own PATH survives; its HOME and TMPDIR do not.
    expect(first!.PATH).toBe("/usr/bin");
    expect(scratchOf(first!)).not.toBe(scratchOf(second!));
    // A root reset ran after each command, on the same VM, before the next one.
    expect(state.resets.map((reset: { vm: number }) => reset.vm)).toEqual([1, 1]);
    const order = state.events.filter((event: string) => event === "reset" || event.startsWith("exec:"));
    expect(order).toEqual([expect.stringMatching(/^exec:/), "reset", expect.stringMatching(/^exec:/), "reset"]);
    await opened.close();
  });

  it("a VM whose image the parser user can write runs nothing (council W #1)", async () => {
    const { state, session } = await open({ lockFails: true, exec: async () => finished() });
    await expect(session()).rejects.toThrow(/creation failed: parser VM image paths are writable by the parser user/);
    expect(state.locks).toBe(1);
    expect(state.commands).toEqual([]);
  });

  it("only a failure after the document's own command ran counts toward its strikes (council U #4)", async () => {
    // VM creation failing (a Modal outage) is a plain retry.
    const { sdk } = fakeSdk({ createFailsFrom: 1, exec: async () => finished() });
    const created = await createModalProvider(async () => sdk).openSession({ ...config, vmsPerActivity: 1 }, { activityId: "a" }).catch((error: unknown) => error);
    expect(created).toBeInstanceOf(SandboxInfrastructureError);
    expect((created as SandboxInfrastructureError).afterCommand).toBe(false);
    // A leftover kill that could not run is Modal's, even after the command.
    const lost = await (await open({ killThrows: "transport", exec: async () => finished() }).then((opened) => opened.session())).run!(command).catch((error: unknown) => error);
    expect((lost as SandboxInfrastructureError).afterCommand).toBe(false);
    // A VM lost while this document's command ran may be its doing: a strike.
    const crashed = await (await open({ exec: async () => { throw new Error("stream reset by peer"); } }).then((opened) => opened.session())).run!(command).catch((error: unknown) => error);
    expect(crashed).toBeInstanceOf(SandboxInfrastructureError);
    expect((crashed as SandboxInfrastructureError).afterCommand).toBe(true);
    // A job tree an earlier document broke is never the next document's strike.
    let broken = false;
    const shared = await open({ mkdirFails: () => broken, exec: async () => finished() });
    const opened = await shared.session();
    await opened.run!({ ...command, affinityKey: "doc-a" });
    broken = true;
    const theirs = await opened.run!({ ...command, affinityKey: "doc-b", writablePaths: ["/job/out"] }).catch((error: unknown) => error);
    expect(theirs).toBeInstanceOf(SandboxInfrastructureError);
    expect((theirs as SandboxInfrastructureError).afterCommand).toBe(false);
    await opened.close();
  });

  it("a command after close, or queued when the session closes, is a retryable infrastructure failure (recheck R #2)", async () => {
    const slow = running();
    const { session } = await open({ exec: async () => slow.process });
    const opened = await session();
    const busy = opened.run!(command).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = opened.run!(command).catch((error: unknown) => error);
    await opened.close();
    slow.end(0);
    await busy;
    expect(await queued).toBeInstanceOf(SandboxInfrastructureError);
    const after = await opened.run!(command).catch((error: unknown) => error);
    expect(after).toBeInstanceOf(SandboxInfrastructureError);
    expect(String((after as Error).message)).toMatch(/session is closed/);
  });

  it("an output over the staging limit is the document's failure, metered and never retried as infrastructure (recheck Q #1)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-q1-"));
    const out = path.join(dir, "out");
    try {
      const { state, session } = await open({ exec: async () => { state.remote.put(path.join(out, "bomb.bin"), "x"); return finished(); } });
      const stat = state.remote.stat.bind(state.remote);
      state.remote.stat = async (p: string) => { const entry = await stat(p); return entry && p.endsWith("bomb.bin") ? { ...entry, size: 200 * 1024 * 1024 } : entry; };
      const opened = await session();
      const failure = await opened.run!({ ...command, writablePaths: [out] }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SandboxOutputError);
      expect(failure).not.toBeInstanceOf(SandboxInfrastructureError);
      expect((failure as SandboxOutputError).usage).toBeDefined();
      const { isDocumentLevelFailure } = await import("../../lib/document-failure.js");
      expect(isDocumentLevelFailure(failure)).toBe(true);
      // Its VM is terminated: the disk and processes a hostile document left are not trusted (recheck S #3). The next
      // document gets a fresh VM.
      expect(state.terminate).toBe(1);
      state.remote.stat = stat;
      await expect(opened.run!(command)).resolves.toMatchObject({ exitCode: 0 });
      expect(state.createOptions).toHaveLength(2);
      await opened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("output the job made unreadable is the document's failure; a transport error is infrastructure (recheck Q #1)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-q1-"));
    const out = path.join(dir, "out");
    try {
      const { state, session } = await open({ exec: async () => { state.remote.put(path.join(out, "locked.txt"), "x"); return finished(); } });
      state.remote.readFile = async () => { throw new Error("EACCES"); };
      const opened = await session();
      expect(await opened.run!({ ...command, writablePaths: [out] }).catch((error: unknown) => error)).toBeInstanceOf(SandboxOutputError);
      await opened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const { session } = await open({ exec: async () => { throw new Error("stream reset by peer"); } });
    const opened = await session();
    expect(await opened.run!(command).catch((error: unknown) => error)).toBeInstanceOf(SandboxInfrastructureError);
    await opened.close();
  });

  it("tells the runner when a queued command is admitted (recheck Q #4)", async () => {
    const slow = running();
    let calls = 0;
    const { session } = await open({ exec: async () => (++calls === 1 ? slow.process : finished()) });
    const opened = await session();
    const events: string[] = [];
    const first = opened.run!(command, undefined, { onStart: () => events.push("first") });
    const second = opened.run!(command, undefined, { onStart: () => events.push("second") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first"]); // the second waits for the VM, not yet started
    slow.end(0);
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
    await opened.close();
  });

  describe("failures a document can force are its own, not the sandbox's (recheck S #2)", () => {
    it("(a) an output listing over its byte bound fails the document and terminates the VM", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "docslurp-s2a-"));
      const out = path.join(dir, "out");
      try {
        const { state, session } = await open({ exec: async () => finished() });
        await state.remote.mkdir(out);
        // Under 8192 entries, but long names: the JSON listing passes 4 MiB.
        const list = state.remote.list.bind(state.remote);
        state.remote.list = async (p: string) => (p === out
          ? Array.from({ length: 5_000 }, (_, i) => ({ path: path.join(out, `${"n".repeat(900)}${i}`), isDir: false, size: 1, mtime: 1 }))
          : list(p));
        const opened = await session();
        const failure = await opened.run!({ ...command, writablePaths: [out] }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(SandboxOutputError);
        expect(String((failure as Error).message)).toMatch(/listing exceeds its limit/);
        expect(state.terminate).toBe(1);
        await opened.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("(b) a leftover kill held up inside the VM (a SIGSTOP loop) fails the document; a kill that cannot run is infrastructure", async () => {
      const stalled = await open({ killThrows: "deadline", exec: async () => finished() });
      const held = await (await stalled.session()).run!(command).catch((error: unknown) => error);
      expect(held).toBeInstanceOf(SandboxOutputError);
      expect(stalled.state.terminate).toBe(1);
      const broken = await open({ killThrows: "transport", exec: async () => finished() });
      const lost = await (await broken.session()).run!(command).catch((error: unknown) => error);
      expect(lost).toBeInstanceOf(SandboxInfrastructureError);
      expect(broken.state.terminate).toBe(1);
    });

    it("(c) a job tree the parser user cannot stage into fails the document that broke it; on a VM another document used last it is infrastructure", async () => {
      const own = await open({ mkdirFails: true, exec: async () => finished() });
      const mine = await (await own.session()).run!({ ...command, affinityKey: "doc-a", writablePaths: ["/job/out"] }).catch((error: unknown) => error);
      expect(mine).toBeInstanceOf(SandboxOutputError);
      expect(own.state.terminate).toBe(1);

      let broken = false;
      const shared = await open({ mkdirFails: () => broken, exec: async () => finished() });
      const opened = await shared.session();
      await opened.run!({ ...command, affinityKey: "doc-a" });
      // doc-a's command left the tree so that staging fails for the next document on this VM.
      broken = true;
      const theirs = await opened.run!({ ...command, affinityKey: "doc-b", writablePaths: ["/job/out"] }).catch((error: unknown) => error);
      expect(theirs).toBeInstanceOf(SandboxInfrastructureError);
      expect(String((theirs as Error).message)).toMatch(/left unusable by an earlier command/);
      expect(shared.state.terminate).toBe(1);
      await opened.close();
    });

    it("a command flooding its stdout past the bound fails its document", async () => {
      const { state, session } = await open({ exec: async () => finished("x".repeat(9 * 1024 * 1024)) });
      const failure = await (await session()).run!(command).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SandboxOutputError);
      expect(String((failure as Error).message)).toMatch(/stdout exceeds its limit/);
      expect(state.terminate).toBe(1);
    });
  });

  it("creates and hardens the VM before admitting the command; a VM that cannot be created never admits it (recheck S #4)", async () => {
    const { sdk, state } = fakeSdk({ createFailsFrom: 2, exec: async () => finished() });
    const provider = createModalProvider(async () => sdk);
    const opened = await provider.openSession({ ...config, vmsPerActivity: 1, vmIdleSeconds: 0.05 }, { activityId: "a" });
    const events: string[] = [];
    await opened.run!(command, undefined, { onStart: () => events.push(`start after ${state.hardened} hardened`) });
    await new Promise((resolve) => setTimeout(resolve, 120)); // the idle VM is reaped
    const failure = await opened.run!(command, undefined, { onStart: () => events.push("admitted without a VM") }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxInfrastructureError);
    expect(String((failure as Error).message)).toMatch(/creation failed/);
    expect(events).toEqual(["start after 1 hardened"]);
    await opened.close();
  });

  it("re-uploads a document's inputs after another document used the VM (recheck S #7)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-s7-"));
    try {
      const input = path.join(dir, "in.txt");
      await writeFile(input, "doc-a input");
      const { state, session } = await open({ exec: async () => finished() });
      const opened = await session();
      // Each upload goes through its own control-dir temp file (written, then removed): count those.
      const uploads = () => new Set(state.rootWrites.filter((target) => target.includes("/upload-"))).size;
      await opened.run!({ ...command, affinityKey: "doc-a", inputPaths: [input] });
      await opened.run!({ ...command, affinityKey: "doc-a", inputPaths: [input] });
      // Every command's uploads are wiped after it (council W #1, W #3): the same document re-uploads too.
      expect(uploads()).toBe(2);
      // doc-b's parser rewrites doc-a's remote copy.
      await opened.run!({ ...command, affinityKey: "doc-b" });
      await state.remote.writeFile(input, Buffer.from("tampered"));
      await opened.run!({ ...command, affinityKey: "doc-a", inputPaths: [input] });
      expect(uploads()).toBe(3);
      expect(Buffer.from(await state.remote.readFile(input)).toString()).toBe("doc-a input");
      await opened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stages read-only assets once per VM, root-owned and read-only, outside the job tree (real-Modal P1)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-clam-definitions-0123456789abcdef"));
    try {
      await writeFile(path.join(dir, "daily.cvd"), "daily signatures");
      await writeFile(path.join(dir, "main.cvd"), "main signatures");
      const { state, session } = await open({ exec: async () => finished() });
      const opened = await session();
      const name = path.basename(dir);
      const scan = (key: string) => opened.run!({ ...command, affinityKey: key, args: ["--database", path.join(dir, "daily.cvd"), "--database", path.join(dir, "main.cvd"), "/job/in.pdf"], inputPaths: [path.join(dir, "daily.cvd"), path.join(dir, "main.cvd")], readOnlyAssetDir: dir });
      await scan("doc-a");
      await scan("doc-b"); // another document on the same VM: no second copy
      const assetWrites = state.rootWrites.filter((target) => target.startsWith(`/opt/docslurp-assets/${name}/`));
      expect(assetWrites.sort()).toEqual([`/opt/docslurp-assets/${name}/daily.cvd`, `/opt/docslurp-assets/${name}/main.cvd`]);
      // Files read-only, directories root-owned 0755: the parser user (uid 10001) can read them, never change them.
      expect(state.chmods.some((args) => args[0] === "0444" && assetWrites.every((file) => args.includes(file)))).toBe(true);
      expect(state.chmods.some((args) => args[0] === "0755" && args.includes("/opt/docslurp-assets"))).toBe(true);
      // The command reads them at the VM path; nothing of them went through the job-tree upload.
      for (const run of state.commands) expect(run).toEqual(expect.arrayContaining([`/opt/docslurp-assets/${name}/daily.cvd`, `/opt/docslurp-assets/${name}/main.cvd`]));
      expect(state.rootWrites.filter((target) => target.includes("/upload-"))).toEqual([]);
      await opened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("meters each command from its admission, not from its wait in the queue (recheck R #3)", async () => {
    const { session } = await open({ exec: async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return finished(); } });
    const opened = await session();
    const startedAt = Date.now();
    const results = await Promise.all([opened.run!(command), opened.run!(command)]);
    const elapsed = (Date.now() - startedAt) / 1000;
    const metered = results.map((result) => Number(result.usage?.metadata?.wallSeconds));
    // One VM, so the two run back to back: together they bill the session's busy time, not 0.3 + 0.6 seconds.
    expect(metered.every((seconds) => seconds >= 0.29 && seconds < 0.45)).toBe(true);
    expect(metered[0]! + metered[1]!).toBeLessThanOrEqual(elapsed + 0.01);
    expect(metered[0]! + metered[1]!).toBeGreaterThanOrEqual(0.58);
    await opened.close();
  });



  describe("a pool of parser VMs per activity (recheck R #5)", () => {
    async function pooled(vmsPerActivity: number, opts: Parameters<typeof fakeSdk>[0] = {}) {
      const { sdk, state } = fakeSdk(opts);
      const provider = createModalProvider(async () => sdk);
      return { state, opened: await provider.openSession({ ...config, vmsPerActivity }, { activityId: "a" }) };
    }

    it("runs concurrent documents in parallel on separate VMs, each VM one command at a time with its own leftover kill", async () => {
      const runs = new Map<number, ReturnType<typeof running>>();
      let active = 0;
      let peak = 0;
      const { state, opened } = await pooled(2, {
        exec: async () => {
          active++; peak = Math.max(peak, active);
          const proc = running();
          runs.set(state.commands.length, proc);
          void proc.process.wait().then(() => active--);
          return proc.process;
        },
      });
      const first = opened.run!({ ...command, affinityKey: "doc-a" });
      const second = opened.run!({ ...command, affinityKey: "doc-b" });
      await vi.waitFor(() => expect(state.commands).toHaveLength(2));
      expect(peak).toBe(2); // both documents' commands run at once
      expect(new Set(state.commandVms)).toEqual(new Set([1, 2]));
      // A third command waits for a VM: the pool never exceeds its cap.
      const third = opened.run!({ ...command, affinityKey: "doc-a" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(state.commands).toHaveLength(2);
      expect(state.createOptions).toHaveLength(2);
      runs.get(1)!.end(0);
      runs.get(2)!.end(0);
      await Promise.all([first, second]);
      await vi.waitFor(() => expect(state.commands).toHaveLength(3));
      runs.get(3)!.end(0);
      await third;
      // doc-a's later command went back to the VM that ran doc-a, which already holds its inputs.
      expect(state.commandVms[2]).toBe(state.commandVms[0]);
      // Every command was followed by its VM's root leftover kill.
      expect(state.leftoverKills).toBe(3);
      expect(state.hardened).toBe(2);
      await opened.close();
      expect(state.terminate).toBe(2);
    });

    it("opens a second VM only when the first is busy", async () => {
      const { state, opened } = await pooled(4, { exec: async () => finished() });
      for (const key of ["a", "b", "c"]) await opened.run!({ ...command, affinityKey: key });
      expect(state.createOptions).toHaveLength(1);
      await opened.close();
    });

    it("a VM that cannot be created for a concurrent command is a retryable infrastructure failure, and the pool recovers", async () => {
      const slow = running();
      let calls = 0;
      const { state, opened } = await pooled(2, { createFailsFrom: 2, exec: async () => (++calls === 1 ? slow.process : finished()) });
      const busy = opened.run!({ ...command, affinityKey: "a" });
      await vi.waitFor(() => expect(state.commands).toHaveLength(1));
      const failure = await opened.run!({ ...command, affinityKey: "b" }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SandboxInfrastructureError);
      expect(String((failure as Error).message)).toMatch(/modal sandbox creation failed: no capacity/);
      slow.end(0);
      await busy;
      // The failed lane is gone; the next command runs on the healthy VM.
      await expect(opened.run!({ ...command, affinityKey: "b" })).resolves.toMatchObject({ exitCode: 0 });
      expect(state.commandVms).toEqual([1, 1]);
      await opened.close();
    });

    it("a command waiting for a VM can be aborted, and close fails waiting commands as infrastructure", async () => {
      const slow = running();
      const { opened } = await pooled(1, { exec: async () => slow.process });
      const busy = opened.run!(command).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const controller = new AbortController();
      const aborted = opened.run!(command, controller.signal).catch((error: unknown) => error);
      controller.abort();
      const abortedError = await aborted;
      expect(abortedError).toBeInstanceOf(SandboxRunError);
      expect(abortedError).not.toBeInstanceOf(SandboxInfrastructureError);
      const waiting = opened.run!(command).catch((error: unknown) => error);
      await opened.close();
      slow.end(0);
      await busy;
      expect(await waiting).toBeInstanceOf(SandboxInfrastructureError);
    });

    it("reaps a VM idle past the window; the next command opens a fresh one (VM pool follow-up)", async () => {
      const { sdk, state } = fakeSdk({ exec: async () => finished() });
      const provider = createModalProvider(async () => sdk);
      const opened = await provider.openSession({ ...config, vmsPerActivity: 2, vmIdleSeconds: 0.1 }, { activityId: "a" });
      await opened.run!(command);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(state.terminate).toBe(0); // still inside the window
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(state.terminate).toBe(1);
      await opened.run!(command);
      expect(state.createOptions).toHaveLength(2);
      await opened.close();
      expect(state.terminate).toBe(2);
    });

    it("meters each VM's whole life, from creation to terminate, across commands, idle time and reaping", async () => {
      const { sdk, state } = fakeSdk({ exec: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return finished(); } });
      const provider = createModalProvider(async () => sdk);
      const opened = await provider.openSession({ ...config, vmsPerActivity: 2, vmIdleSeconds: 0.15 }, { activityId: "a" });
      const recorded: number[] = [];
      const hooks = { recordUsage: (event: { metadata?: Record<string, unknown> }) => recorded.push(Number(event.metadata?.wallSeconds)) };
      const metered: number[] = [];
      const run = async (key: string) => metered.push(Number((await opened.run!({ ...command, affinityKey: key }, undefined, hooks)).usage?.metadata?.wallSeconds));
      await new Promise((resolve) => setTimeout(resolve, 80)); // idle before the first command
      await Promise.all([run("a"), run("b")]); // two VMs
      await new Promise((resolve) => setTimeout(resolve, 60)); // idle between commands
      await run("a");
      await new Promise((resolve) => setTimeout(resolve, 300)); // both reaped
      expect(state.terminate).toBe(2);
      const lifetime = state.createdAt.reduce((total, created, index) => total + (state.terminatedAt[index]! - created), 0) / 1000;
      const billed = [...metered, ...recorded].reduce((total, seconds) => total + seconds, 0);
      expect(recorded).toHaveLength(2); // one tail per VM
      expect(Math.abs(billed - lifetime)).toBeLessThan(0.05);
      await opened.close();
    });

    it("bills a VM from when Modal's create returns, not from the request (real-Modal M1)", async () => {
      // A slow app lookup before the create returns: about 0.2 s Modal never bills.
      const createGate = new Promise<void>((resolve) => setTimeout(resolve, 200));
      const { sdk, state } = fakeSdk({ lookupDelayMs: 200, createGate, exec: async () => finished() });
      const provider = createModalProvider(async () => sdk);
      const requested = Date.now();
      const opened = await provider.openSession({ ...config, vmsPerActivity: 1, vmIdleSeconds: 60 }, { activityId: "a" });
      const tails: number[] = [];
      const result = await opened.run!(command, undefined, { recordUsage: (event) => tails.push(Number(event.metadata?.wallSeconds)) });
      await opened.close();
      expect(state.createdAt[0]! - requested).toBeGreaterThanOrEqual(190);
      const lifetime = (state.terminatedAt[0]! - state.createdAt[0]!) / 1000;
      const billed = Number(result.usage?.metadata?.wallSeconds) + tails.reduce((total, seconds) => total + seconds, 0);
      expect(Math.abs(billed - lifetime)).toBeLessThan(0.05);
      expect(billed).toBeLessThan((state.terminatedAt[0]! - requested) / 1000 - 0.15);
    });

    it("settle terminates idle VMs and records their remaining time before the stage's checkpoint", async () => {
      const { sdk, state } = fakeSdk({ exec: async () => finished() });
      const provider = createModalProvider(async () => sdk);
      const opened = await provider.openSession({ ...config, vmsPerActivity: 2, vmIdleSeconds: 60 }, { activityId: "a" });
      const recorded: unknown[] = [];
      await opened.run!(command, undefined, { recordUsage: (event) => recorded.push(event) });
      await opened.settle!();
      expect(state.terminate).toBe(1);
      expect(recorded).toHaveLength(1);
      await opened.run!(command); // still usable: a fresh VM
      expect(state.createOptions).toHaveLength(2);
      await opened.close();
    });

    it("caps parser VMs per worker across activities; a waiting activity takes another activity's idle VM", async () => {
      const slow = running();
      let calls = 0;
      const { sdk, state } = fakeSdk({ exec: async () => (++calls === 1 ? slow.process : finished()) });
      const provider = createModalProvider(async () => sdk);
      const pooled = { ...config, vmsPerActivity: 4, vmsPerWorker: 2, vmIdleSeconds: 60 };
      const a = await provider.openSession(pooled, { activityId: "a" });
      const b = await provider.openSession(pooled, { activityId: "b" });
      expect(state.createOptions).toHaveLength(2);
      const busy = a.run!({ ...command, affinityKey: "x" }); // A's VM busy
      await vi.waitFor(() => expect(state.commands).toHaveLength(1));
      await b.run!(command); // B's own VM; B is now idle with one VM
      // A wants a second VM: the worker is at its limit, so B's idle VM is reaped for it.
      await a.run!({ ...command, affinityKey: "y" });
      expect(state.createOptions).toHaveLength(3);
      expect(state.terminate).toBe(1);
      slow.end(0);
      await busy;
      await Promise.all([a.close(), b.close()]);
      expect(state.terminate).toBe(3);
    });

    it("holds the worker's VM capacity and keeps metering until Modal acknowledges a slow terminate (recheck T #1)", async () => {
      let ack!: () => void;
      const terminateGate = new Promise<void>((resolve) => (ack = resolve));
      const { sdk, state } = fakeSdk({ terminateGate, exec: async () => finished() });
      const provider = createModalProvider(async () => sdk);
      const pooled = { ...config, vmsPerActivity: 1, vmsPerWorker: 1, vmIdleSeconds: 60 };
      const a = await provider.openSession(pooled, { activityId: "a" });
      const tails: number[] = [];
      await a.run!(command, undefined, { recordUsage: (event) => tails.push(Number(event.metadata?.wallSeconds)) });
      const settling = a.settle!(); // terminate requested, not yet acknowledged
      const opening = provider.openSession(pooled, { activityId: "b" });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(state.createOptions).toHaveLength(1); // no second VM while the first may still run
      expect(tails).toEqual([]); // still metering
      ack();
      await settling;
      const b = await opening;
      expect(state.createOptions).toHaveLength(2);
      expect(tails).toHaveLength(1);
      expect(tails[0]!).toBeGreaterThanOrEqual(0.11); // metered through the acknowledgement
      expect(state.createdAt[1]!).toBeGreaterThanOrEqual(state.terminatedAt[0]!); // never two at once
      await b.close();
    });

    it("quarantines capacity after a terminate that cannot be confirmed, billed to the VM's lifetime limit (recheck T #1)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { sdk, state } = fakeSdk({ terminateFails: true, exec: async () => finished() });
      const provider = createModalProvider(async () => sdk);
      const pooled = { ...config, vmsPerActivity: 1, vmsPerWorker: 1, vmIdleSeconds: 60, sessionTimeoutSeconds: 0.4 };
      const a = await provider.openSession(pooled, { activityId: "a" });
      const tails: number[] = [];
      await a.run!(command, undefined, { recordUsage: (event) => tails.push(Number(event.metadata?.wallSeconds)) });
      await a.settle!();
      expect(state.lateTerminate).toBe(1); // retried on a fresh client, refused too
      expect(tails).toHaveLength(1);
      // Billed to the lifetime limit counted from creation (0.4 s), not to the failed request.
      const created = state.createdAt[0]!;
      expect(tails[0]!).toBeGreaterThan(0.3);
      const started = Date.now();
      const b = provider.openSession(pooled, { activityId: "b" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(state.createOptions).toHaveLength(1); // the quarantined token is still taken
      await b.then((session) => session.close().catch(() => {}));
      expect(state.createdAt[1]!).toBeGreaterThanOrEqual(created + 400 - 5); // only after the limit
      expect(Date.now() - started).toBeLessThan(2_500);
    });

    it("a quarantined VM's capacity is held for its lifetime from when Modal created it, not from the request (council V #1)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { sdk, state } = fakeSdk({ terminateFails: true, lookupDelayMs: 300, exec: async () => finished() });
      const provider = createModalProvider(async () => sdk);
      const pooled = { ...config, vmsPerActivity: 1, vmsPerWorker: 1, vmIdleSeconds: 60, sessionTimeoutSeconds: 0.4 };
      const a = await provider.openSession(pooled, { activityId: "a" });
      await a.run!(command);
      await a.settle!(); // terminate refused: quarantined
      const b = await provider.openSession(pooled, { activityId: "b" });
      // The replacement's own create came at least the lifetime after the first VM's create returned.
      expect(state.createdAt[1]! - state.createdAt[0]!).toBeGreaterThanOrEqual(400 - 5);
      await b.close().catch(() => {});
    });

    it("holds capacity while a creation is unconfirmed, and frees it once the late VM is stopped (council V #1)", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        let release!: () => void;
        const createGate = new Promise<void>((resolve) => (release = resolve));
        const { sdk, state } = fakeSdk({ createGate, exec: async () => finished() });
        const provider = createModalProvider(async () => sdk);
        const pooled = { ...config, vmsPerActivity: 1, vmsPerWorker: 1, vmIdleSeconds: 60, createSettleMs: 30 };
        // A's create hangs past its 30 s deadline; its terminate gives up waiting after 30 ms: creation unconfirmed.
        const failed = provider.openSession(pooled, { activityId: "a" }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(30_001);
        await vi.advanceTimersByTimeAsync(31);
        expect(await failed).toBeInstanceOf(Error);
        // The worker's only token stays with the unconfirmed create: B does not start a VM, however long it waits.
        let bOpened = false;
        const b = provider.openSession(pooled, { activityId: "b" }).then((session) => { bOpened = true; return session; });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(bOpened).toBe(false);
        expect(state.createOptions).toHaveLength(1);
        // The create finally returns: that late VM is stopped (fresh client), and only then does B get the token.
        release();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(state.lateTerminate).toBe(1);
        const session = await b;
        expect(state.createOptions).toHaveLength(2);
        await session.close();
      } finally { vi.useRealTimers(); }
    });

    it("frees an unconfirmed creation's capacity as soon as Modal rejects that create, with no quarantine (council U #7)", async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        let reject!: (error: Error) => void;
        const createGate = new Promise<void>((_resolve, fail) => (reject = fail));
        createGate.catch(() => {});
        const { sdk, state } = fakeSdk({ createGate, exec: async () => finished() });
        const provider = createModalProvider(async () => sdk);
        const pooled = { ...config, vmsPerActivity: 1, vmsPerWorker: 1, vmIdleSeconds: 60, createSettleMs: 30 };
        const failed = provider.openSession(pooled, { activityId: "a" }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(30_001);
        await vi.advanceTimersByTimeAsync(31);
        expect(await failed).toBeInstanceOf(Error);
        // B waits: the worker's only token is with A's unconfirmed create.
        const b = provider.openSession(pooled, { activityId: "b" }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(state.createOptions).toHaveLength(1);
        // Modal rejects the late create: no VM exists, so nothing is stopped and the token goes straight to B (not 15 min).
        // (This fake's gate rejects B's create too; what matters is that B was admitted to create a VM.)
        reject(new Error("create rejected"));
        await vi.advanceTimersByTimeAsync(100);
        expect(state.createOptions).toHaveLength(2);
        expect(state.lateTerminate).toBe(0);
        await vi.advanceTimersByTimeAsync(31_000);
        await b;
      } finally { vi.useRealTimers(); }
    });

    it("waits for a worker VM before admitting a command, and an abort ends that wait (recheck T #2)", async () => {
      const slow = running();
      let calls = 0;
      const { sdk, state } = fakeSdk({ exec: async (argv) => (argv[0] === "/bin/slow" && ++calls === 1 ? slow.process : finished()) });
      const provider = createModalProvider(async () => sdk);
      const pooled = { ...config, vmsPerActivity: 2, vmsPerWorker: 1, vmIdleSeconds: 60 };
      const b = await provider.openSession(pooled, { activityId: "b" });
      await b.run!(command); // B's VM, now idle
      const a = await provider.openSession(pooled, { activityId: "a" }); // the worker is full: B's idle VM is reaped for A
      expect(state.terminate).toBe(1);
      const busy = a.run!({ ...command, binary: "/bin/slow" });
      await vi.waitFor(() => expect(state.commands.some(([binary]) => binary === "/bin/slow")).toBe(true));

      // B has no VM and the worker no token: B's command is queued, not admitted, and its abort ends the wait.
      const events: string[] = [];
      const controller = new AbortController();
      const waiting = b.run!(command, controller.signal, { onStart: () => events.push("aborted") }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual([]);
      controller.abort();
      const aborted = await waiting;
      expect(aborted).toBeInstanceOf(SandboxRunError);
      expect(aborted).not.toBeInstanceOf(SandboxInfrastructureError);

      // Another waits the same way, and is admitted once A's VM is idle and handed over.
      const later = b.run!(command, undefined, { onStart: () => events.push("later") });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual([]);
      slow.end(0);
      await Promise.all([busy, later]);
      expect(events).toEqual(["later"]);
      expect(state.createOptions).toHaveLength(3); // B, A, then B again: never two at once (worker cap 1)
      for (let vm = 1; vm < 3; vm++) expect(state.createdAt[vm]!).toBeGreaterThanOrEqual(state.terminatedAt[vm - 1]!);
      await Promise.all([a.close(), b.close()]);
    });

    it("a command waiting for a worker VM takes over its own activity's VM when it goes idle, instead of a new one (real-Modal P2)", async () => {
      let ack!: () => void;
      const terminateGate = new Promise<void>((resolve) => (ack = resolve));
      const slow = running();
      let calls = 0;
      const { sdk, state } = fakeSdk({ terminateGate, exec: async (argv) => (argv[0] === "/bin/slow" && ++calls === 1 ? slow.process : finished()) });
      const provider = createModalProvider(async () => sdk);
      const pooled = { ...config, vmsPerActivity: 2, vmsPerWorker: 2, vmIdleSeconds: 60 };
      const c = await provider.openSession(pooled, { activityId: "c" });
      await c.run!(command); // C's VM, idle
      const a = await provider.openSession(pooled, { activityId: "a" });
      const busy = a.run!({ ...command, binary: "/bin/slow", affinityKey: "x" });
      await vi.waitFor(() => expect(state.commands.some(([binary]) => binary === "/bin/slow")).toBe(true));
      // A's second command opens a lane (C holds an idle VM to give up); C's terminate is slow, so it waits for a token.
      const second = a.run!({ ...command, affinityKey: "y" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(state.createOptions).toHaveLength(2);
      slow.end(0); // A's own VM goes idle: the waiting command takes it over
      await Promise.all([busy, second]);
      expect(state.createOptions).toHaveLength(2); // no third VM for A
      ack();
      await Promise.all([a.close(), c.close()]);
    });

    it("sizes the pool from the document and candidate concurrency settings", () => {
      expect(modalVmsPerActivity({ WORKER_DOC_CONCURRENCY: "4" })).toBe(8);
      expect(modalVmsPerActivity({ WORKER_DOC_CONCURRENCY: "4", WORKER_SERIALIZE_PDF_CANDIDATES: "1" })).toBe(4);
      expect(modalVmsPerActivity({ WORKER_DOC_CONCURRENCY: "1", WORKER_SERIALIZE_PDF_CANDIDATES: "true" })).toBe(1);
      expect(modalVmsPerActivity({ WORKER_DOC_CONCURRENCY: "4", DOCSLURP_MODAL_VMS_PER_ACTIVITY: "3" })).toBe(3);
      expect(modalVmsPerActivity({ WORKER_DOC_CONCURRENCY: "64" })).toBe(16);
      expect(modalVmsPerActivity({ DOCSLURP_MODAL_VMS_PER_ACTIVITY: "0", WORKER_DOC_CONCURRENCY: "2" })).toBe(4);
      expect(modalVmsPerWorker({ WORKER_ACTIVITY_CONCURRENCY: "2" })).toBe(2);
      expect(modalVmsPerWorker({ WORKER_ACTIVITY_CONCURRENCY: "8", DOCSLURP_MODAL_VMS_PER_WORKER: "3" })).toBe(3);
      expect(modalVmIdleSeconds({})).toBe(20);
      expect(modalVmIdleSeconds({ DOCSLURP_MODAL_VM_IDLE_SECONDS: "0" })).toBe(20);
      expect(modalVmIdleSeconds({ DOCSLURP_MODAL_VM_IDLE_SECONDS: "45" })).toBe(45);
    });
  });

  it("a job VM whose link hardening fails runs nothing and is terminated (Modal check)", async () => {
    const commands: string[][] = [];
    const { state, session } = await open({ hardeningFails: true, exec: async (argv) => { commands.push(argv); return finished(); } });
    await expect(session()).rejects.toThrow(/creation failed/);
    expect(state.hardened).toBe(1);
    expect(commands).toEqual([]);
    expect(state.terminate).toBe(1);
  });

  it("starts every parser VM with the idle command, never the image's entrypoint (validation N1)", async () => {
    const { state, session } = await open();
    await (await session()).close();
    expect(state.createOptions[0]).toMatchObject({ command: ["sleep", "infinity"] });
  });

  it("a terminate request that never answers is retried on a fresh client and does not hang close (validation N1)", async () => {
    vi.useFakeTimers();
    try {
      const { state, session } = await open({ terminateHangs: true });
      const opened = await session();
      const closing = opened.close().then(() => "closed", (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await closing).toBe("closed");
      expect(state.lateTerminate).toBe(1);
      expect(state.clientClose).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("the startup probe's VM gets a short lifetime and a stuck teardown does not fail the probe (validation N1)", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { sdk, state } = fakeSdk({ terminateHangs: true, exec: async () => finished(JSON.stringify({ protocol: "parser-vm@2", uid: 10001, links: { hardlinks: 1, symlinks: 1 }, hardening: { suidDumpable: 0, ptraceScope: 1 } })) });
      const provider = createModalProvider(async () => sdk);
      const probing = provider.probe(config);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await probing).toMatchObject({ ok: true });
      expect(state.createOptions[0]).toMatchObject({ command: ["sleep", "infinity"], timeoutMs: Math.min(config.sessionTimeoutSeconds, 120) * 1000 });
      expect(state.lateTerminate).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it("close terminates the sandbox once and is idempotent", async () => {
    const { state, session } = await open();
    const opened = await session();
    await opened.close();
    await opened.close();
    expect(state.terminate).toBe(1);
    expect(state.clientClose).toBe(1);
    expect(state.createOptions[0]).toMatchObject({ runtime: "vm", blockNetwork: true, includeOidcIdentityToken: false, env: {}, secrets: [], volumes: {}, cloudBucketMounts: {} });
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

  it("a discard that fails terminates the VM; the next command runs on a fresh one (recheck Q #8)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-discard-"));
    try {
      const partial = path.join(dir, "partial.json");
      let calls = 0;
      const { state, session } = await open({
        exec: async () => {
          if (++calls > 1) return finished();
          state.remote.put(partial, "{");
          throw new Error("Deadline exceeded while streaming stdio for exec x");
        },
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const remove = state.remote.remove.bind(state.remote);
      state.remote.remove = async () => { throw new Error("rm failed"); };
      const opened = await session();
      expect((await opened.run!({ ...command, writablePaths: [dir] })).exitCode).toBeNull();
      expect(state.terminate).toBe(1);
      state.remote.remove = remove;
      await expect(opened.run!({ ...command, writablePaths: [dir] })).resolves.toMatchObject({ exitCode: 0 });
      expect(state.createOptions).toHaveLength(2);
      expect(state.commandVms).toEqual([1, 2]);
      await opened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes an aborted command's changes before the next command in the session starts (commands run one at a time, council O #4)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-serial-"));
    try {
      const processes = new Map<string, ReturnType<typeof running>>();
      const { state, session } = await open({
        exec: async ([binary]) => {
          const proc = running();
          processes.set(binary, proc);
          state.remote.put(path.join(dir, `${binary}.json`), binary === "next" ? "{\"done\":true}" : "{");
          if (binary === "next") proc.end(0);
          return proc.process;
        },
        onKill: () => processes.get("aborted")?.end(137),
      });
      const opened = await session();
      const controller = new AbortController();
      const aborted = opened.run!({ ...command, binary: "aborted", writablePaths: [dir] }, controller.signal).catch((e: unknown) => e);
      await vi.waitFor(() => expect(processes.has("aborted")).toBe(true));
      const next = opened.run!({ ...command, binary: "next", writablePaths: [dir] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(processes.has("next")).toBe(false); // waits for the aborted command, its discard and the leftover kill
      controller.abort();
      expect((await aborted) as Error).toBeInstanceOf(SandboxRunError);
      await next;
      expect(state.remote.removed).toEqual([path.join(dir, "aborted.json")]);
      expect(readFileSync(path.join(dir, "next.json"), "utf8")).toBe("{\"done\":true}");
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

  it("drops pending removals and queued commands once the session is closed", async () => {
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
      const aborted = opened.run!({ ...command, binary: "aborted", writablePaths: [dir] }, controller.signal).catch((e: unknown) => e);
      await vi.waitFor(() => expect(processes.has("aborted")).toBe(true));
      const queued = opened.run!({ ...command, binary: "queued", writablePaths: [dir] }).catch((e: unknown) => e);
      await opened.close();
      controller.abort();
      await aborted;
      expect(await queued).toBeInstanceOf(Error);
      expect(processes.has("queued")).toBe(false);
      expect(state.remote.removed).toEqual([]);
      // No discard ran against the closed sandbox (the only warning allowed is the idle VM time this direct run, outside
      // a stage, has nowhere to record).
      expect(warn.mock.calls.filter(([line]) => !String(line).startsWith("[sandbox-usage]"))).toEqual([]);
    } finally {
      warn.mockRestore();
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

    // Root stages the bytes in its control directory; the parser user copies them to the input path (council M #3).
    expect(state.remote.writes.filter((p: string) => !p.startsWith("/tmp/.docslurp-modal-control/"))).toEqual([input]);
    // Besides the job tree, only the command's own HOME/temp/XDG scratch (council W #1).
    const scratchDirs = state.mkdirs.filter((p: string) => /\/\.cmd-\d+-\d+\//.test(p));
    expect(scratchDirs.length).toBe(7);
    expect(state.mkdirs.filter((p: string) => !scratchDirs.includes(p))).toEqual(["/tmp/.docslurp-modal-control", workspace]);
    const staged = [...state.remote.writes.filter((p: string) => !p.startsWith("/tmp/.docslurp-modal-control/")), ...state.mkdirs.slice(1)].join("\n");
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

  it("records the provider cost at the pricing provider's sandbox rates, on the sandbox's own size", () => {
    for (const [cpu, memoryMb] of [[2, 2048], [2, 3072]] as const) {
      const event = buildModalUsageEvent({ ...lifecycleConfig, cpu, memoryMb }, "activity-1", 10);
      const expected = pricing().internalCost.sandboxCostCents({ provider: "modal", cores: cpu, memoryGib: memoryMb / 1024, seconds: 10 });
      expect(expected).toBeGreaterThan(0);
      expect(Number(event.metadata?.providerCostCents)).toBeCloseTo(expected, 10);
      expect(event.metadata).toMatchObject({ physicalCores: cpu, memoryGib: memoryMb / 1024, rateSource: "modal-sandbox", costRole: "provider" });
      expect(event.costCents).toBe(0);
    }
    // A larger sandbox costs more.
    expect(Number(buildModalUsageEvent({ ...lifecycleConfig, cpu: 2, memoryMb: 3072 }, "a", 10).metadata?.providerCostCents))
      .toBeGreaterThan(Number(buildModalUsageEvent({ ...lifecycleConfig, cpu: 2, memoryMb: 2048 }, "a", 10).metadata?.providerCostCents));
  });
});

describe("modal usage amount is not provider cost (real-Modal run)", () => {
  it("the loss alert and spend attribution read providerCostCents, and amount only for billable metrics", async () => {
    const { readFileSync } = await import("node:fs");
    const attribution = readFileSync(new URL("../../../../server/src/services/usage-attribution.ts", import.meta.url), "utf8");
    // The provider-cost loss query takes provider cost from metadata.providerCostCents, never from amount.
    const loss = attribution.slice(attribution.indexOf("const lossItems"), attribution.indexOf("const lossItems") + 2_000);
    expect(loss).toMatch(/metadata -> 'providerCostCents'/);
    expect(loss).not.toMatch(/\bamount\b/);
    // amount is summed per metric, and only billable unit metrics are read from that sum.
    const sums = attribution.slice(attribution.indexOf("sum(au.amount)") - 1_500, attribution.indexOf("sum(au.amount)") + 1_500);
    expect([...sums.matchAll(/get\(([^)]+)\)\.amount/g)].every(([, metric]) => metric!.startsWith("BILLABLE_UNIT_METRICS."))).toBe(true);
    const event = buildModalUsageEvent(lifecycleConfig, "a", 10);
    expect(event.metric).toBe("sandbox_compute");
    expect(event.costCents).toBe(0);
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

  const digest = `sha256:${"ab".repeat(32)}`;

  it("pins the default release image by digest when DOCSLURP_MODAL_IMAGE_DIGEST is set", () => {
    expect(provider.readConfig({ ...tokens, DOCSLURP_VERSION: "1.2.3", DOCSLURP_MODAL_IMAGE_DIGEST: digest }).image).toBe(
      `ghcr.io/docslurp/worker-full@${digest}`,
    );
  });

  it("accepts digest-pinned images and keeps registry ports", () => {
    expect(provider.readConfig({ ...tokens, DOCSLURP_MODAL_IMAGE: `ghcr.io/docslurp/worker-full@${digest}` }).image).toBe(
      `ghcr.io/docslurp/worker-full@${digest}`,
    );
    expect(provider.readConfig({ ...tokens, DOCSLURP_MODAL_IMAGE: "registry.local:5000/parsers:1", DOCSLURP_MODAL_IMAGE_DIGEST: digest }).image).toBe(
      `registry.local:5000/parsers@${digest}`,
    );
    expect(provider.readConfig({ ...tokens, DOCSLURP_MODAL_IMAGE: "registry.local:5000/parsers" }).image).toBe("registry.local:5000/parsers");
  });

  it("rejects malformed or conflicting digests without echoing values", () => {
    const read = (env: Record<string, string>) => () => provider.readConfig({ ...tokens, DOCSLURP_VERSION: "1.2.3", ...env });
    expect(read({ DOCSLURP_MODAL_IMAGE_DIGEST: "sha256:short" })).toThrow(/invalid: DOCSLURP_MODAL_IMAGE_DIGEST/);
    expect(read({ DOCSLURP_MODAL_IMAGE: "example/parsers@md5:abc" })).toThrow(/invalid: DOCSLURP_MODAL_IMAGE /);
    expect(
      read({ DOCSLURP_MODAL_IMAGE: `example/parsers@sha256:${"cd".repeat(32)}`, DOCSLURP_MODAL_IMAGE_DIGEST: digest }),
    ).toThrow(/does not match/);
  });

  it("requires DOCSLURP_MODAL_IMAGE when DOCSLURP_VERSION is unset", () => {
    const read = () => provider.readConfig({ ...tokens });
    expect(read).toThrow(SandboxConfigError);
    expect(read).toThrow(/DOCSLURP_MODAL_IMAGE.*DOCSLURP_VERSION is unset/);
  });
});
