import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";
import { documentExtractorRegistry } from "../extractors/registry.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import type { Document, WorkspaceRun } from "../models.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { resolveCommandPaths } from "../sandbox/paths.js";
import { deniedSyscalls, seccompFilter } from "../sandbox/seccomp.js";
import { buildTestPdf, proseLines } from "../test/make-pdf.js";
import bubblewrap from "../sandbox/providers/bubblewrap/index.js";
import {
  resetStagedSourcesForTests,
  SourceIntegrityError,
  stagedSourceSha256,
  stageSourceFile,
  verifyStagedSource,
} from "../sandbox/source-integrity.js";
import {
  admitCommandSource,
  configureSourceQuarantine,
  findQuarantinedSourceError,
  flushSourceQuarantine,
  QuarantinedOrgError,
  type SourceQuarantineStore,
} from "../sandbox/source-quarantine.js";
import { rethrowIfTeardown } from "../sandbox/teardown-breaker.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { teardownBreakerState } from "../sandbox/teardown-breaker.js";
import {
  CommandTeardownError,
  probePidNamespace,
  recordUnverifiedTeardown,
  resetUnverifiedTeardownsForTests,
  spawnContained,
  superviseChild,
  unverifiedTeardownCount,
} from "../sandbox/teardown.js";
import { SandboxPolicyError, type SandboxSession } from "../sandbox/types.js";
import { CommandRunner, resolveScriptsDir } from "../tools/runner.js";

// Reproduces the #234 round-7 council findings. Real processes and real bwrap where they matter.
const linux = process.platform === "linux";
const pidNamespace = linux && probePidNamespace().ok;
const bwrapAvailable = linux && spawnSync("bwrap", ["--version"]).status === 0;
const python = linux && existsSync("/usr/bin/python3") ? realpathSync("/usr/bin/python3") : "python3";
const pythonAvailable = spawnSync(python, ["-c", "pass"]).status === 0;
const filterArch = ["x64", "arm64"].includes(process.arch);

const roots: string[] = [];
const strays: number[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

beforeEach(() => resetUnverifiedTeardownsForTests());

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  configureSourceQuarantine(null);
  resetStagedSourcesForTests();
  resetUnverifiedTeardownsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function silence(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

/**
 * The reviewer's attack: park stdout and stderr in a self-referential SCM_RIGHTS cycle of socketpairs
 * and exit. Nothing in the sandbox references the cycle any more, but the descriptors stay open
 * until the kernel's next UNIX-socket garbage collection, which on a quiet host is seconds away.
 */
const CHAIN = String.raw`
import array, os, socket, sys
def send(sock, fds):
    sock.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))])
n = 64
sys.stdout.write("chain-start\n"); sys.stdout.flush()
pairs = [socket.socketpair() for _ in range(n)]
send(pairs[0][0], [1, 2])
for i in range(n):
    a, b = pairs[i]
    nxt = pairs[(i + 1) % n]
    send(a, [nxt[0].fileno(), nxt[1].fileno()])
for a, b in pairs:
    a.close(); b.close()
os._exit(0)
`;

/**
 * Holds every descriptor sent to `socketPath` for `seconds`: a stand-in, outside every namespace, for
 * the kernel holding a parked descriptor. Deterministic where the garbage collector's timing is not.
 */
const HOLDER = String.raw`
import array, os, socket, sys, time
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sys.argv[1]); srv.listen(8)
print("ready", flush=True)
held = []
srv.settimeout(float(sys.argv[2]))
end = time.time() + float(sys.argv[2])
while time.time() < end:
    try:
        conn, _ = srv.accept()
    except socket.timeout:
        break
    msg, anc, _, _ = conn.recvmsg(16, socket.CMSG_SPACE(16 * 4))
    for level, kind, data in anc:
        fds = array.array("i"); fds.frombytes(data[: len(data) - len(data) % 4]); held.extend(fds)
    held.append(conn)
time.sleep(max(0, end - time.time()))
`;

/** A `bwrap` that hands its stdout and stderr to the holder, writes a line, and exits 0. */
const FAKE_BWRAP = String.raw`#!PYTHON
import array, os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(os.environ.get("DOCSLURP_TEST_HOLDER") or "HOLDER_SOCKET")
s.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [1, 2]))])
sys.stdout.write("parked\n"); sys.stdout.flush()
os._exit(0)
`;

async function startHolder(dir: string, seconds: number): Promise<string> {
  const socketPath = path.join(dir, "holder.sock");
  const holder = spawn(python, ["-I", "-c", HOLDER, socketPath, String(seconds)], { stdio: ["ignore", "pipe", "inherit"] });
  strays.push(holder.pid!);
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    holder.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
  return socketPath;
}

describe("H1: the sandbox never holds the worker's stdio", () => {
  it.skipIf(!linux || !pythonAvailable)(
    "control: a command that parks its own stdout outside its namespace is an attributable teardown",
    async () => {
      silence();
      const dir = scratch("docslurp-h1-control-");
      const socketPath = await startHolder(dir, 20);
      const script = path.join(dir, "park.py");
      writeFileSync(script, FAKE_BWRAP.replace("#!PYTHON", `#!${python}`));
      const child = spawnContained(python, ["-I", script], {
        env: { PATH: process.env.PATH ?? "", DOCSLURP_TEST_HOLDER: socketPath },
        containment: pidNamespace ? "pid-namespace" : "process-group",
      });
      const supervised = superviseChild(child, {
        label: "park",
        timings: { graceMs: 200, launcherGraceMs: 200, verifyMs: 500, drainCapMs: 2_000 },
      });
      const error = await supervised.done.then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(CommandTeardownError);
      expect((error as CommandTeardownError).attributable).toBe(true);
    },
    30_000,
  );

  it.skipIf(!bwrapAvailable || !pidNamespace || !pythonAvailable || !filterArch)(
    "behind the launcher's relay, a parked descriptor holds only the relay's pipe: no teardown failure",
    async () => {
      const dir = scratch("docslurp-h1-relay-");
      const socketPath = await startHolder(dir, 20);
      // A fake bwrap first on PATH: the launcher and the relay run it in bwrap's place.
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      // The runner passes the command a filtered environment: bake the holder's path in.
      writeFileSync(path.join(bin, "bwrap"), FAKE_BWRAP.replace("#!PYTHON", `#!${python}`).replace("HOLDER_SOCKET", socketPath));
      chmodSync(path.join(bin, "bwrap"), 0o755);
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("WORKER_COMMAND_TEARDOWN_VERIFY_MS", "500");
      const config = { scratchRoot: path.join(dir, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "h1-relay" });
      const runner = new CommandRunner({ openSession: async () => session });
      const started = Date.now();
      const result = await runner.run({ binary: "/usr/bin/true", args: [], available: true });
      expect(result.stdout).toBe("parked\n");
      // It ended when the fake bwrap exited, not when the holder let go 20 s later.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(unverifiedTeardownCount()).toBe(0);
      expect(teardownBreakerState().open).toBe(false);
    },
    30_000,
  );

  it.skipIf(!bwrapAvailable || !pidNamespace || !pythonAvailable || !filterArch)(
    "the SCM_RIGHTS chain under real bwrap ends cleanly, every time, without tripping the breaker",
    async () => {
      const root = scratch("docslurp-h1-chain-");
      const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "h1-chain" });
      const runner = new CommandRunner({ openSession: async () => session });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await runner.run({ binary: python, args: ["-I", "-c", CHAIN], available: true });
        expect(result.stdout).toBe("chain-start\n");
      }
      expect(unverifiedTeardownCount()).toBe(0);
      expect(teardownBreakerState().open).toBe(false);
    },
    60_000,
  );

  it.skipIf(!linux)("the relay copies all output, keeps the exit status, and exits even while a descendant holds its pipe", () => {
    const relay = path.join(resolveScriptsDir(), "stdio-relay.pl");
    const big = spawnSync("perl", [relay, "sh", "-c", "head -c 3000000 /dev/zero; echo err >&2; exit 3"], { maxBuffer: 8e6 });
    expect(big.status).toBe(3);
    expect(big.stdout.length).toBe(3_000_000);
    expect(big.stderr.toString()).toBe("err\n");
    expect(spawnSync("perl", [relay, "sh", "-c", "kill -9 $$"]).status).toBe(137);
    expect(spawnSync("perl", [relay, "/nonexistent/binary"]).status).toBe(127);
    const started = Date.now();
    // The background sleep keeps the relay's inner pipe open for 10 s; the relay must not wait on it.
    const held = spawnSync("perl", [relay, "sh", "-c", "echo before; sleep 10 & exit 0"], { encoding: "utf8", timeout: 8_000 });
    expect(held.stdout).toBe("before\n");
    expect(held.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: "a.pdf", mimeType: "application/pdf", sourceKey: "user-1/raw/a.pdf",
    status: "queued", extractionMode: "hybrid", pageCount: 1, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeRun(): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload", status: "processing",
    stage: "extract-markdown", totalDocuments: 1, processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures }, error: null, stats: {}, artifacts: {}, claimId: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

/** Storage whose object can be replaced after the server hashed it (the H2 attack). */
function mutableStorage(initial: string) {
  let body = initial;
  const downloads: string[] = [];
  return {
    replace(next: string) {
      body = next;
    },
    downloads,
    async downloadToTempFile(_key: string, pattern: string) {
      const dir = mkdtempSync(path.join(tmpdir(), "docslurp-"));
      roots.push(dir);
      const file = path.join(dir, pattern.replace(/\*/g, "x"));
      writeFileSync(file, body);
      downloads.push(file);
      return file;
    },
    async getBytes() {
      return Buffer.from(body);
    },
  };
}

describe("H2: the worker parses only the bytes the server hashed", () => {
  it("refuses, loudly and for good, a source whose staged bytes differ from documents.source_sha256", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const document = makeDocument({ sourceSha256: sha("popular public PDF") });
    const storage = mutableStorage("popular public PDF");
    // Verified bytes stage fine and their staged hash is remembered for the quarantine.
    const file = await stageSourceFile(storage, document, "source-*.pdf");
    expect(stagedSourceSha256("doc-1")).toBe(sha("popular public PDF"));
    // The client PUTs hostile bytes to the still-valid URL after the server hashed P.
    storage.replace("hostile bytes");
    const refused = await stageSourceFile(storage, document, "source-*.pdf").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SourceIntegrityError);
    expect(refused).toMatchObject({ expectedSha256: sha("popular public PDF"), stagedSha256: sha("hostile bytes") });
    // The refused download is removed; the earlier verified one is untouched.
    expect(existsSync(storage.downloads[1]!)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
      /\[worker-source\] status=source-hash-mismatch .*document=doc-1 .*expected_sha256=[0-9a-f]{64} staged_sha256=[0-9a-f]{64}/,
    );
    // Final: no fallback catches it, no strategy retries it, and it fails the Document.
    expect(findQuarantinedSourceError(refused)).toBe(refused);
    expect(() => rethrowIfTeardown(refused)).toThrow(refused as Error);
    expect(isDocumentLevelFailure(refused)).toBe(true);
    const state = WorkflowState.create(makeRun(), [document]);
    const run = vi.fn(async () => {
      throw refused;
    });
    await runDocumentStage(state, document, "extract-markdown", "doc-1:markdown", "extracted", run, undefined, {
      retryStrategies: ["docling", "poppler-text"],
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.documentStage("doc-1", "extract-markdown")?.status).toBe("failed");
    // Bytes read in memory (embedding fallbacks) are checked the same way.
    const { readSourceBytes } = await import("../sandbox/source-integrity.js");
    await expect(readSourceBytes(storage, document)).rejects.toBeInstanceOf(SourceIntegrityError);
  });

  it("the shared PDF source cache verifies every document against its hash and drops a mismatched entry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = mutableStorage("version one");
    const cache = new PdfSourceCache(storage as never);
    const first = makeDocument({ sourceSha256: sha("version one") });
    expect((await cache.get(first)).sha256).toBe(sha("version one"));
    // Another document (a new version) with the same key but different server hash is refused from the cache.
    const other = makeDocument({ id: "doc-2", sourceSha256: sha("version two") });
    await expect(cache.get(other)).rejects.toBeInstanceOf(SourceIntegrityError);
    // The entry was dropped: the next call downloads again and verifies the current bytes.
    storage.replace("version two");
    expect((await cache.get(other)).sha256).toBe(sha("version two"));
    expect(storage.downloads).toHaveLength(2);
    await cache.clear();
  });

  it("a document without a server hash is staged and keyed by its staged hash", () => {
    verifyStagedSource(makeDocument({ id: "unhashed", sourceSha256: null }), sha("x"));
    expect(stagedSourceSha256("unhashed")).toBe(sha("x"));
  });

  it("the quarantine records and checks the staged hash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const finds: Array<[string, string | null | undefined]> = [];
    const records: Array<{ documentId: string; stagedSha256?: string | null }> = [];
    configureSourceQuarantine({
      async find(documentId, staged) {
        finds.push([documentId, staged]);
        return null;
      },
      async record(entry) {
        records.push(entry);
        return { sourceSha256: entry.stagedSha256 ?? "none", orgId: "org-1", workspaceId: "ws-1" };
      },
      async noteRefusal() {},
      async recordOrgFailure() {
        return null;
      },
      async orgFailures() {
        return null;
      },
    });
    verifyStagedSource(makeDocument({ sourceSha256: sha("bytes") }), sha("bytes"));
    await inDocument(() => admitCommandSource());
    expect(finds).toEqual([["doc-1", sha("bytes")]]);
    recordUnverifiedTeardown(new CommandTeardownError("held", { attributable: true }), "label=x", {
      attribution: { document_id: "doc-1", run_id: "run-1", stage: "extract-markdown" },
    });
    await flushSourceQuarantine();
    expect(records[0]).toMatchObject({ documentId: "doc-1", stagedSha256: sha("bytes") });
  });
});

const inDocument = <T>(fn: () => Promise<T>, documentId = "doc-1") =>
  runWithPerfContext(
    { runId: "run-1", documentId, orgId: "org-1", workspaceId: "ws-1", scope: "document", stageName: "extract-markdown", pushPerformance: () => {} },
    fn,
  );

describe("H1: an organization whose parser work keeps defeating teardown is refused fleet-wide", () => {
  function orgStore(initial = 0) {
    let count = initial;
    const recorded: Array<{ documentId: string; attributable: boolean }> = [];
    const store: SourceQuarantineStore = {
      async find() {
        return null;
      },
      async record() {
        return null;
      },
      async noteRefusal() {},
      async recordOrgFailure(entry) {
        recorded.push({ documentId: entry.documentId, attributable: entry.attributable });
        count += 1;
        return { orgId: "org-1", count };
      },
      async orgFailures() {
        return count > 0 ? { orgId: "org-1", count } : null;
      },
    };
    return { store, recorded };
  }

  it("counts every teardown (attributable or not), alerts at the limit, and then refuses the organization's documents", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("WORKER_ORG_TEARDOWN_LIMIT", "2");
    const { store, recorded } = orgStore();
    configureSourceQuarantine(store);
    for (const [documentId, attributable] of [["doc-a", false], ["doc-b", true]] as const) {
      await inDocument(() => admitCommandSource(), documentId);
      recordUnverifiedTeardown(new CommandTeardownError("held", { attributable }), "label=x", {
        attribution: { document_id: documentId, run_id: "run-1" },
      });
      await flushSourceQuarantine();
    }
    expect(recorded).toEqual([{ documentId: "doc-a", attributable: false }, { documentId: "doc-b", attributable: true }]);
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
      /status=org-breaker-open metric=org_teardown_breaker_open org=org-1 failures=2 limit=2/,
    );
    // A new document of that organization (new bytes: the source denylist would not catch it) is refused.
    const refused = await inDocument(() => admitCommandSource(), "doc-c").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(QuarantinedOrgError);
    expect(isDocumentLevelFailure(refused)).toBe(true);
    expect(findQuarantinedSourceError(refused)).toBe(refused);
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/status=org-refused metric=org_parser_refused org=org-1/);
    // The runner refuses before opening a sandbox session (on a worker whose own breaker is closed:
    // this one opened at the first teardown).
    resetUnverifiedTeardownsForTests();
    const opened = vi.fn(async () => {
      throw new Error("must not open a session");
    });
    const runner = new CommandRunner({ openSession: opened });
    await expect(inDocument(() => runner.run({ binary: "/bin/true", args: [], available: true }), "doc-d")).rejects.toBeInstanceOf(QuarantinedOrgError);
    expect(opened).not.toHaveBeenCalled();
  });

  it("below the limit the organization's documents still run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = orgStore(2);
    configureSourceQuarantine(store);
    await expect(inDocument(() => admitCommandSource())).resolves.toBeUndefined();
  });
});

describe("M2: the shared PDF source is read-only for every command", () => {
  it("no plan gets the cached source's directory writable, and writing beside it is refused", async () => {
    const storage = mutableStorage("%PDF-1.4");
    const cache = new PdfSourceCache(storage as never);
    const cached = await cache.get(makeDocument({ sourceSha256: sha("%PDF-1.4") }));
    const resolve = (args: string[], readOnlyInputs = false) =>
      resolveCommandPaths({
        plan: { binary: "/usr/bin/pdftotext", args, available: true, ...(readOnlyInputs ? { readOnlyInputs } : {}) },
        venvBin: "/nonexistent/bin",
        scratchRoot: "/nonexistent/scratch",
        configuredWritablePaths: [],
        scriptsDir: resolveScriptsDir(),
      });
    // Without readOnlyInputs (a parser activity of another document version): still read-only.
    const paths = resolve([cached.path, "-"]);
    expect(paths.writablePaths).toEqual([]);
    expect(paths.readablePaths).toContain(cached.path);
    // An output beside the shared source would make its directory writable: fail closed.
    expect(() => resolve([cached.path, `${cached.path}.doppler.md`])).toThrow(/shared source/);
    await cache.clear();
    // Once evicted the path is an ordinary file again.
    expect(() => resolve([cached.path, `${cached.path}.doppler.md`])).not.toThrow();
  });
});

describe("Low: candidate isolation settles every sibling before failing", () => {
  it("a failing candidate waits for its sibling's copy before the caller removes the directories", async () => {
    const sourceDir = mkdtempSync(path.join(tmpdir(), "docslurp-source-cache-"));
    roots.push(sourceDir);
    const source = path.join(sourceDir, "doc.pdf");
    writeFileSync(source, "%PDF-1.4");
    let siblingSettled = false;
    vi.spyOn(documentExtractorRegistry, "prepare").mockImplementation(async (id: string) => {
      if (id === "kreuzberg") throw new Error("prepare failed");
      await new Promise((resolve) => setTimeout(resolve, 150));
      siblingSettled = true;
      return { label: id, plan: { binary: "pdftotext", args: [], available: true } } as never;
    });
    const stage = new ExtractMarkdownStage({} as never, {} as never, {} as never);
    const dirs: string[] = [];
    const error = await (stage as unknown as { isolateConcurrentCandidates(args: object): Promise<unknown> })
      .isolateConcurrentCandidates({
        primary: { label: "kreuzberg" },
        secondary: { label: "poppler-text" },
        sourcePath: source,
        format: "pdf",
        options: {},
        dirs,
      })
      .catch((caught: unknown) => caught);
    roots.push(...dirs);
    expect((error as Error).message).toBe("prepare failed");
    // With Promise.all the rejection came first and the sibling was still copying and preparing.
    expect(siblingSettled).toBe(true);
    expect(dirs).toHaveLength(2);
    // Removing them now leaves nothing behind (no sibling recreates its directory later).
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dirs.filter((dir) => existsSync(dir))).toEqual([]);
    expect(readdirSync(sourceDir)).toEqual(["doc.pdf"]);
  });
});

/**
 * Raw system calls (x86_64 numbers passed in as JSON) that a contained parser could use to reach
 * kernel attack surface. Prints one JSON object: name -> errno (0 = it worked).
 */
const NAMESPACE_PROBE = String.raw`
import ctypes, json, os, subprocess, sys, threading
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
nr = json.loads(sys.argv[1])
def call(n, *args):
    ctypes.set_errno(0)
    r = libc.syscall(ctypes.c_long(n), *[ctypes.c_long(a) for a in args])
    if r == 0 and n == nr["clone"]:
        libc._exit(0)
    if r > 0 and n == nr["clone"]:
        os.waitpid(r, 0)
    return 0 if r >= 0 else ctypes.get_errno()
out = {}
out["unshare_user"] = call(nr["unshare"], 0x10000000)
out["unshare_net"] = call(nr["unshare"], 0x40000000)
out["clone_newuser"] = call(nr["clone"], 0x10000000 | 17, 0, 0, 0, 0)
out["clone3"] = call(nr["clone3"], 0, 0)
out["setns"] = call(nr["setns"], -1, 0)
out["keyctl"] = call(nr["keyctl"], 0, -3, 0)
out["add_key"] = call(nr["add_key"], 0, 0, 0, 0, 0)
out["userfaultfd"] = call(nr["userfaultfd"], 0)
attr = ctypes.create_string_buffer(128)
out["perf_event_open"] = call(nr["perf_event_open"], ctypes.addressof(attr), 0, -1, -1, 0)
out["bpf"] = call(nr["bpf"], 0, 0, 0)
out["process_vm_readv"] = call(nr["process_vm_readv"], os.getpid(), 0, 0, 0, 0, 0)
out["mount"] = call(nr["mount"], 0, 0, 0, 0, 0)
out["fsopen"] = call(nr["fsopen"], 0, 0)
# What parsers do keeps working: fork, threads (glibc tries clone3, then clone) and subprocess.
pid = os.fork()
if pid == 0:
    os._exit(7)
out["fork"] = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
t = threading.Thread(target=lambda: None); t.start(); t.join()
out["thread"] = 0
out["subprocess"] = subprocess.run(["/bin/sh", "-c", "exit 3"]).returncode
print(json.dumps(out))
`;

describe("M1: every sandboxed command is denied namespaces and kernel attack surface", () => {
  it("both profiles deny the Docker-default-like list on x64 and arm64; clone3 is ENOSYS, clone with CLONE_NEW* EPERM", () => {
    for (const arch of ["x64", "arm64"]) {
      const denied = deniedSyscalls(arch)!;
      expect(Object.keys(denied)).toEqual(
        expect.arrayContaining(["unshare", "setns", "mount", "bpf", "perf_event_open", "userfaultfd", "keyctl", "add_key", "request_key", "process_vm_readv", "process_vm_writev", "fsopen", "open_tree"]),
      );
      for (const profile of ["base", "deny-unix-sockets"] as const) {
        const filter = seccompFilter(profile, arch)!;
        const ks = Array.from({ length: filter.length / 8 }, (_, index) => filter.readUInt32LE(index * 8 + 4));
        expect(ks).toEqual(expect.arrayContaining([...Object.values(denied), 435, 0x00050000 | 1, 0x00050000 | 38, 0x7e020080]));
      }
    }
  });

  const x64 = process.arch === "x64";
  it.skipIf(!bwrapAvailable || !pidNamespace || !pythonAvailable || !x64)(
    "under real bwrap: namespaces, keyrings, userfaultfd, perf, bpf, process_vm and the mount API fail; fork, threads and subprocess work",
    async () => {
      const numbers = JSON.stringify({ ...deniedSyscalls("x64"), clone: 56, clone3: 435 });
      // Positive control on the host, no filter: a user namespace can be created here.
      const host = JSON.parse(spawnSync(python, ["-I", "-c", NAMESPACE_PROBE, numbers], { encoding: "utf8" }).stdout) as Record<string, number>;
      const root = scratch("docslurp-bwrap-namespaces-");
      const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "namespaces" });
      const runner = new CommandRunner({ openSession: async () => session });
      for (const denyUnixSockets of [false, true]) {
        const result = await runner.run({ binary: python, args: ["-I", "-c", NAMESPACE_PROBE, numbers], available: true, denyUnixSockets });
        const probe = JSON.parse(result.stdout) as Record<string, number>;
        for (const name of ["unshare_user", "unshare_net", "clone_newuser", "setns", "keyctl", "add_key", "userfaultfd", "perf_event_open", "bpf", "process_vm_readv", "mount", "fsopen"]) {
          expect([name, probe[name]]).toEqual([name, 1]);
        }
        expect(probe.clone3).toBe(38);
        expect(probe).toMatchObject({ fork: 7, thread: 0, subprocess: 3 });
      }
      // The host control differs where it matters: without the filter these are not EPERM.
      expect(host.keyctl).not.toBe(1);
      expect(host.clone3).not.toBe(38);
    },
    60_000,
  );

  const has = (binary: string) => spawnSync("sh", ["-c", `command -v ${binary}`]).status === 0;
  it.skipIf(!bwrapAvailable || !pidNamespace || !filterArch || !has("pdftoppm") || !has("qpdf") || !has("tesseract"))(
    "poppler, qpdf, tesseract and python still run under the filters with real bwrap",
    async () => {
      const root = scratch("docslurp-bwrap-tools-");
      const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "tools" });
      const runner = new CommandRunner({ openSession: async () => session });
      const sourceDir = scratch("docslurp-source-");
      const source = path.join(sourceDir, "in.pdf");
      writeFileSync(source, buildTestPdf([{ kind: "text", lines: proseLines(5) }]));
      const outDir = scratch("docslurp-page-");
      const bin = (name: string) => realpathSync(spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim());
      await runner.run({ binary: bin("pdftoppm"), args: ["-png", "-r", "60", "-f", "1", "-l", "1", "--", source, path.join(outDir, "page")], available: true, readOnlyInputs: true });
      const png = readdirSync(outDir).find((name) => name.endsWith(".png"))!;
      expect(png).toBeTruthy();
      expect((await runner.run({ binary: bin("pdftotext"), args: [source, "-"], available: true })).stdout.length).toBeGreaterThan(20);
      expect((await runner.run({ binary: bin("qpdf"), args: ["--check", source], available: true })).stdout).toMatch(/No syntax or stream encoding errors/);
      const ocr = await runner.run({ binary: bin("tesseract"), args: [path.join(outDir, png), "-", "--psm", "6"], available: true });
      expect(ocr.stdout.trim().length).toBeGreaterThan(0);
      const py = await runner.run({ binary: python, args: ["-I", "-c", "import multiprocessing as m, concurrent.futures as f\nwith f.ThreadPoolExecutor(2) as e: print(sum(e.map(abs, [-1, -2])))"], available: true });
      expect(py.stdout.trim()).toBe("3");
    },
    120_000,
  );

  // The launcher's minimal /etc does not start this host's LibreOffice (it hangs at 466defe9 too, with no
  // filter), so this runs bwrap directly with the host's /etc and the filter on descriptor 9, as the
  // launcher passes it.
  it.skipIf(!bwrapAvailable || !filterArch || !has("soffice"))(
    "LibreOffice (an audited UNIX-socket client: base profile) still converts a document under the filter (real bwrap --seccomp)",
    async () => {
      const work = scratch("docslurp-office-");
      for (const profile of ["base"] as const) {
        const input = path.join(work, `note-${profile}.txt`);
        writeFileSync(input, "Sandboxed LibreOffice conversion\n");
        const filter = (await import("node:fs")).openSync((await import("../sandbox/seccomp.js")).ensureSeccompFilterFile(work, profile), "r");
        const home = path.join(work, `home-${profile}`);
        mkdirSync(home);
        const child = spawn(
          "bwrap",
          [
            "--unshare-net", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--cap-drop", "ALL",
            "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc",
            ...["/bin", "/lib", "/lib64", "/sbin"].flatMap((dir) => (existsSync(dir) ? ["--ro-bind", dir, dir] : [])),
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", work, work, "--setenv", "HOME", home,
            "--seccomp", "9", "--",
            realpathSync(spawnSync("sh", ["-c", "command -v soffice"], { encoding: "utf8" }).stdout.trim()),
            "--headless", "--convert-to", "pdf", input, "--outdir", work,
          ],
          { stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", filter] },
        );
        strays.push(child.pid!);
        let stderr = "";
        child.stderr?.on("data", (chunk) => (stderr += chunk));
        const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
        expect([profile, code, stderr.slice(0, 400)]).toEqual([profile, 0, expect.any(String)]);
        expect(readdirSync(work)).toContain(`note-${profile}.pdf`);
      }
    },
    120_000,
  );
});

describe("L2: only a remote session may run commands without local containment", () => {
  const runOnly = (location: "local" | "remote"): SandboxSession => ({
    providerId: `run-only-${location}`,
    isolation: { filesystem: true, network: "full", processes: true, location },
    run: vi.fn(async () => ({ exitCode: 0, stdout: "remote\n", stderr: "" })),
    close: async () => {},
  });

  it("refuses a local session that offers run() without spawn()", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = runOnly("local");
    const runner = new CommandRunner({ openSession: async () => session });
    await expect(runner.run({ binary: "/usr/bin/pdftotext", args: ["-v"], available: true })).rejects.toBeInstanceOf(SandboxPolicyError);
    expect(session.run).not.toHaveBeenCalled();
  });

  it("a remote session still runs its commands", async () => {
    const session = runOnly("remote");
    const runner = new CommandRunner({ openSession: async () => session });
    expect((await runner.run({ binary: "/usr/bin/pdftotext", args: ["-v"], available: true })).stdout).toBe("remote\n");
    expect(session.run).toHaveBeenCalledTimes(1);
  });
});
