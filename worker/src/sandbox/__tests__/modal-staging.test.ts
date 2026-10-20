import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRunner, resolveVenvBin } from "../../tools/runner.js";
import { resolveScriptsDir } from "../../tools/scripts-dir.js";
import { buildModalUsageEvent, createModalProvider, type ModalSdk } from "../providers/modal/index.js";
import { SessionStaging, type RemoteFs } from "../providers/modal/staging.js";
import { SandboxConfigError, SandboxRunError } from "../types.js";

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

/** A Modal SDK double: records filesystem traffic and lets each test script `exec`. */
function fakeSdk(opts: { createFails?: boolean; exec?: (argv: string[]) => Promise<FakeProcess> } = {}) {
  const state = {
    terminate: 0,
    clientClose: 0,
    writes: [] as string[],
    mkdirs: [] as string[],
    stats: [] as string[],
    images: [] as Array<[string, unknown]>,
  };
  const sandbox = {
    terminate: async () => void state.terminate++,
    filesystem: {
      makeDirectory: async (p: string) => void state.mkdirs.push(p),
      writeBytes: async (_data: Uint8Array, p: string) => void state.writes.push(p),
      stat: async (p: string) => {
        state.stats.push(p);
        throw new NotFound();
      },
      listFiles: async () => [],
    },
    exec: opts.exec ?? (async () => finished()),
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

  it("aborting one command rejects only that command; the session keeps running others", async () => {
    let release!: (process: FakeProcess) => void;
    let calls = 0;
    const { state, session } = await open({
      exec: () => (++calls === 1 ? new Promise<FakeProcess>((resolve) => (release = resolve)) : Promise.resolve(finished("second"))),
    });
    const opened = await session();
    const controller = new AbortController();
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-abort-"));
    try {
      const running = opened.run!({ ...command, writablePaths: [dir] }, controller.signal).catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      const error = await running;
      expect((error as Error).message).toContain("aborted");
      expect(state.terminate).toBe(0);

      const next = await opened.run!(command);
      expect(next.exitCode).toBe(0);
      expect(next.stdout).toBe("second");

      // The abandoned exec finishing later must not write its outputs back.
      release(finished("late"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.stats).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await opened.close();
    expect(state.terminate).toBe(1);
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

    expect(state.writes).toEqual([input]);
    expect(state.mkdirs).toEqual([workspace]);
    const staged = [...state.writes, ...state.mkdirs].join("\n");
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
