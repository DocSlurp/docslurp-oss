import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSandboxActivityInterceptor } from "../sandbox/activity-interceptor.js";
import { resolveCommandPaths } from "../sandbox/paths.js";
import bubblewrap from "../sandbox/providers/bubblewrap/index.js";
import { ensureSeccompFilterFile, seccompFilter } from "../sandbox/seccomp.js";
import { closeSandboxQuietly } from "../sandbox/session-context.js";
import {
  configureSourceQuarantine,
  flushSourceQuarantine,
  type SourceQuarantineStore,
} from "../sandbox/source-quarantine.js";
import {
  CommandTeardownError,
  probePidNamespace,
  recordUnverifiedTeardown,
  resetUnverifiedTeardownsForTests,
  spawnContained,
  superviseChild,
} from "../sandbox/teardown.js";
import { SandboxPolicyError, type SandboxSession } from "../sandbox/types.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { COMMAND_TEARDOWN_UNVERIFIED } from "../temporal/failure-classification.js";
import { buildTestPdf, proseLines } from "../test/make-pdf.js";
import { assertUnixSocketFilter, CommandRunner, deniesUnixSockets, resolveScriptsDir } from "../tools/runner.js";

// Reproduces the #234 round-6 council findings. Real processes and real bwrap where they matter.
const linux = process.platform === "linux";
const pidNamespace = linux && probePidNamespace().ok;
const bwrapAvailable = linux && spawnSync("bwrap", ["--version"]).status === 0;
const pdftoppm = spawnSync("pdftoppm", ["-v"]).status === 0;

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
  resetUnverifiedTeardownsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function silence(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

/**
 * io_uring with raw syscalls (no liburing): io_uring_setup, then one IORING_OP_SOCKET(AF_UNIX).
 * Prints `setup <errno>` if setup fails, else `uring-socket family <n>` or `uring-socket <errno>`.
 */
const URING_PROBE = String.raw`
import ctypes, mmap, socket, struct
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
params = ctypes.create_string_buffer(120)
fd = libc.syscall(425, ctypes.c_uint(4), params)
if fd < 0:
    print("setup", ctypes.get_errno()); raise SystemExit(0)
sq_entries, cq_entries = struct.unpack_from("II", params, 0)
sq_head, sq_tail, sq_mask, _, _, _, sq_array = struct.unpack_from("7I", params, 40)
cq_head, cq_tail, cq_mask, _, _, cq_cqes = struct.unpack_from("6I", params, 80)
sq = mmap.mmap(fd, sq_array + sq_entries * 4, offset=0)
cq = mmap.mmap(fd, cq_cqes + cq_entries * 16, offset=0x8000000)
sqes = mmap.mmap(fd, sq_entries * 64, offset=0x10000000)
sqe = bytearray(64)
struct.pack_into("BBHi", sqe, 0, 45, 0, 0, socket.AF_UNIX)
struct.pack_into("Q", sqe, 8, socket.SOCK_STREAM)
sqes[0:64] = bytes(sqe)
tail = struct.unpack_from("I", sq, sq_tail)[0]
struct.pack_into("I", sq, sq_array + (tail & struct.unpack_from("I", sq, sq_mask)[0]) * 4, 0)
struct.pack_into("I", sq, sq_tail, tail + 1)
if libc.syscall(426, fd, 1, 1, 1, None, 0) < 0:
    print("enter", ctypes.get_errno()); raise SystemExit(0)
head = struct.unpack_from("I", cq, cq_head)[0]
res = struct.unpack_from("i", cq, cq_cqes + (head & struct.unpack_from("I", cq, cq_mask)[0]) * 16 + 8)[0]
print("uring-socket", -res if res < 0 else "family %d" % socket.socket(fileno=res).family.value)
`;

const python = linux && existsSync("/usr/bin/python3") ? realpathSync("/usr/bin/python3") : "python3";
const hostUring = linux ? spawnSync(python, ["-I", "-c", URING_PROBE], { encoding: "utf8" }).stdout.trim() : "";

describe("H1: io_uring cannot create sockets past the seccomp filter", () => {
  it("both profiles deny io_uring_setup, io_uring_enter and io_uring_register on x64 and arm64", () => {
    for (const arch of ["x64", "arm64"]) {
      for (const profile of ["base", "deny-unix-sockets"] as const) {
        const filter = seccompFilter(profile, arch)!;
        const ks = Array.from({ length: filter.length / 8 }, (_, index) => filter.readUInt32LE(index * 8 + 4));
        expect(ks).toEqual(expect.arrayContaining([425, 426, 427, 0x00050000 | 38]));
      }
    }
    expect(seccompFilter("base", "x64")?.length).toBe(10 * 8);
    expect(seccompFilter("base", "arm64")?.length).toBe(9 * 8);
    expect(seccompFilter("base", "riscv64")).toBeNull();
  });

  // The host itself (no filter) lets io_uring make an AF_UNIX socket: the probe is real.
  it.skipIf(!linux || hostUring === "")("positive control: without the filter, IORING_OP_SOCKET creates an AF_UNIX socket", (ctx) => {
    if (!hostUring.includes("uring-socket family 1")) ctx.skip(`io_uring unavailable on this host: ${hostUring}`);
    expect(hostUring).toBe("uring-socket family 1");
  });

  it.skipIf(!bwrapAvailable || !pidNamespace || !["x64", "arm64"].includes(process.arch))(
    "every bubblewrap command, socket-using or not, gets ENOSYS from io_uring_setup",
    async () => {
      const root = scratch("docslurp-bwrap-uring-");
      const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "uring" });
      const runner = new CommandRunner({ openSession: async () => session });
      const plan = { binary: python, args: ["-I", "-c", URING_PROBE], available: true };
      // python is a UNIX-socket client (base profile) unless the plan opts into the stricter one.
      expect(deniesUnixSockets(plan)).toBe(false);
      expect((await runner.run(plan)).stdout.trim()).toBe("setup 38");
      expect((await runner.run({ ...plan, denyUnixSockets: true })).stdout.trim()).toBe("setup 38");
      // Both filters were written, and nothing is left of either command's instance.
      expect(readdirSync(config.scratchRoot).filter((name) => name.endsWith(".bpf")).sort()).toEqual([
        `seccomp-base-${process.arch}.bpf`,
        `seccomp-deny-unix-sockets-${process.arch}.bpf`,
      ]);
    },
    30_000,
  );

  it.skipIf(!bwrapAvailable || !pidNamespace || !pdftoppm || !["x64", "arm64"].includes(process.arch))(
    "poppler still renders under the stricter filter, by default and with a read-only input",
    async () => {
      const root = scratch("docslurp-bwrap-poppler-");
      const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "poppler" });
      const runner = new CommandRunner({ openSession: async () => session });
      const sourceDir = scratch("docslurp-source-");
      const source = path.join(sourceDir, "in.pdf");
      writeFileSync(source, buildTestPdf([{ kind: "text", lines: proseLines(5) }]));
      const outDir = scratch("docslurp-page-");
      const plan = {
        binary: realpathSync("/usr/bin/pdftoppm"),
        args: ["-png", "-r", "50", "-f", "1", "-l", "1", "--", source, path.join(outDir, "page")],
        available: true,
        readOnlyInputs: true,
      };
      expect(deniesUnixSockets(plan)).toBe(true);
      await runner.run(plan);
      const pages = readdirSync(outDir).filter((name) => name.endsWith(".png"));
      expect(pages).toHaveLength(1);
      expect(readFileSync(path.join(outDir, pages[0]!)).subarray(1, 4).toString()).toBe("PNG");
    },
    30_000,
  );

  it.skipIf(!bwrapAvailable)("the launcher only accepts a filter directly inside the sandbox root", () => {
    const root = scratch("docslurp-seccomp-traversal-");
    const sandboxRoot = path.join(root, "sandbox");
    const outside = ensureSeccompFilterFile(root, "base");
    const launcher = path.join(resolveScriptsDir(), "parser-sandbox.sh");
    // `${root}/seccomp-*.bpf` as a [[ ]] pattern would have matched this path.
    const traversal = path.join(sandboxRoot, "seccomp-x", "..", "..", path.basename(outside));
    const result = spawnSync("bash", [launcher, "/usr/bin/true"], {
      env: { PATH: process.env.PATH, DOCSLURP_PARSER_SANDBOX_ROOT: sandboxRoot, DOCSLURP_PARSER_SANDBOX_SECCOMP: traversal },
      encoding: "utf8",
    });
    expect(result.status).toBe(70);
    expect(result.stderr).toMatch(/refusing seccomp filter/);
  });
});

describe("M1: a provider that cannot filter UNIX sockets refuses the commands that need the filter", () => {
  const unfiltered = (providerId: string): SandboxSession => ({
    providerId,
    isolation: { filesystem: true, network: "tcp-only", processes: pidNamespace, location: "local" },
    spawn: (command) => spawnContained(command.binary, command.args, { env: command.env, containment: pidNamespace ? "pid-namespace" : "process-group", init: true }),
    close: async () => {},
  });

  it("socketless tools are denied UNIX sockets by default; audited socket clients are not", () => {
    for (const binary of ["pdftoppm", "/usr/bin/pdfinfo", "qpdf", "tesseract", "pandoc", "unrtf", "catdoc", "tiffcp", "clamscan", "some-new-tool"]) {
      expect(deniesUnixSockets({ binary }), binary).toBe(true);
    }
    for (const binary of ["clamdscan", "soffice", "/opt/venv/bin/python3", "python3.13", "node", "docling", "kreuzberg"]) {
      expect(deniesUnixSockets({ binary }), binary).toBe(false);
    }
    expect(deniesUnixSockets({ binary: "pdftoppm", denyUnixSockets: false })).toBe(false);
  });

  it("refuses without the opt-in, and with it under NODE_ENV=production", () => {
    silence();
    vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "");
    const command = { binary: "pdftoppm", denyUnixSockets: true };
    expect(() => assertUnixSocketFilter({ providerId: "landlock" }, command)).toThrow(SandboxPolicyError);
    expect(() => assertUnixSocketFilter({ providerId: "none" }, command)).toThrow(/cannot stop 'pdftoppm' from creating UNIX sockets/);
    vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertUnixSocketFilter({ providerId: "landlock" }, command)).toThrow(SandboxPolicyError);
    vi.stubEnv("NODE_ENV", "development");
    expect(() => assertUnixSocketFilter({ providerId: "landlock" }, command)).not.toThrow();
    // A filtering session, or a command that may use sockets, never needs the opt-in.
    vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "");
    expect(() => assertUnixSocketFilter({ providerId: "bubblewrap", filtersUnixSockets: true }, command)).not.toThrow();
    expect(() => assertUnixSocketFilter({ providerId: "landlock" }, { binary: "python3" })).not.toThrow();
  });

  it.skipIf(!linux)("the runner refuses before spawning, and runs the command once opted in", async () => {
    silence();
    vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "");
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
    const session = unfiltered("landlock");
    const spawned = vi.spyOn(session, "spawn");
    const runner = new CommandRunner({ openSession: async () => session });
    // /bin/echo is not an audited socket client, so it asks for the filter.
    const plan = { binary: "/bin/echo", args: ["ran"], available: true };
    await expect(runner.run(plan)).rejects.toBeInstanceOf(SandboxPolicyError);
    expect(spawned).not.toHaveBeenCalled();
    vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "1");
    expect((await runner.run(plan)).stdout.trim()).toBe("ran");
  });
});

describe("M2: concurrent extractor candidates share no writable directory", () => {
  it("each concurrent candidate is prepared against its own private copy of the source", async () => {
    const sourceDir = scratch("docslurp-source-cache-");
    const source = path.join(sourceDir, "doc.pdf");
    writeFileSync(source, buildTestPdf([{ kind: "text", lines: proseLines(3) }]));
    const runner = new CommandRunner();
    const stage = new ExtractMarkdownStage(runner, {} as never, { serializePdfCandidateExtraction: false } as never);
    const { documentExtractorRegistry } = await import("../extractors/registry.js");
    const prepare = (id: string) => documentExtractorRegistry.prepare(id, runner, source, undefined, { format: "pdf" });
    const dirs: string[] = [];
    const isolated = await (stage as unknown as {
      isolateConcurrentCandidates(args: object): Promise<{ primary: { extractor: { plan: { args: string[]; binary: string } }; source: string }; secondary: { extractor: { plan: { args: string[]; binary: string } }; source: string } }>;
    }).isolateConcurrentCandidates({
      primary: await prepare("kreuzberg"),
      secondary: await prepare("poppler-text"),
      sourcePath: source,
      format: "pdf",
      options: {},
      dirs,
    });
    roots.push(...dirs);
    expect(dirs).toHaveLength(2);
    const writable = [isolated.primary, isolated.secondary].map(({ extractor, source: copy }) => {
      expect(path.dirname(copy)).not.toBe(sourceDir);
      expect(readFileSync(copy).equals(readFileSync(source))).toBe(true);
      expect(extractor.plan.args).toContain(copy);
      expect(extractor.plan.args).not.toContain(source);
      return resolveCommandPaths({
        plan: { ...extractor.plan, available: true },
        venvBin: "/nonexistent/bin",
        scratchRoot: "/nonexistent/scratch",
        configuredWritablePaths: [],
        scriptsDir: resolveScriptsDir(),
      }).writablePaths;
    });
    expect(writable[0]).toEqual([path.dirname(isolated.primary.source)]);
    expect(writable[1]).toEqual([path.dirname(isolated.secondary.source)]);
    expect(writable.flat()).not.toContain(sourceDir);
  });

  // Round 7 (M2): the cached source is shared across activities, so even a lone candidate gets a copy.
  it("a single or serialized candidate also gets its own copy; the cached source stays read-only", async () => {
    const sourceDir = scratch("docslurp-source-cache-");
    const source = path.join(sourceDir, "doc.pdf");
    writeFileSync(source, "%PDF-1.4");
    const runner = new CommandRunner();
    const { documentExtractorRegistry } = await import("../extractors/registry.js");
    const candidate = await documentExtractorRegistry.prepare("poppler-text", runner, source, undefined, { format: "pdf" });
    for (const [serialize, secondary] of [[false, null], [true, candidate]] as const) {
      const stage = new ExtractMarkdownStage(runner, {} as never, { serializePdfCandidateExtraction: serialize } as never);
      const dirs: string[] = [];
      const isolated = await (stage as unknown as { isolateConcurrentCandidates(args: object): Promise<{ primary: { source: string } }> })
        .isolateConcurrentCandidates({ primary: candidate, secondary, sourcePath: source, format: "pdf", options: {}, dirs });
      roots.push(...dirs);
      expect(isolated.primary.source).not.toBe(source);
      expect(path.dirname(isolated.primary.source)).toBe(dirs[0]);
      expect(dirs).toHaveLength(secondary ? 2 : 1);
    }
  });
});

describe("M3: only a teardown the command caused lists its source, and only for a while", () => {
  function fakeStore() {
    const records: Array<{ documentId: string; ttlHours: number }> = [];
    const store: SourceQuarantineStore = {
      async find() {
        return null;
      },
      async record(entry) {
        records.push({ documentId: entry.documentId, ttlHours: entry.ttlHours });
        return { sourceSha256: "sha", orgId: "org-1", workspaceId: "ws-1" };
      },
      async noteRefusal() {},
      async recordOrgFailure() {
        return null;
      },
      async orgFailures() {
        return null;
      },
    };
    return { store, records };
  }
  const attribution = { org_id: "org-1", run_id: "run-1", document_id: "doc-1", stage: "extract-markdown" };

  it("a timing or host failure quarantines the worker but never lists the source", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, records } = fakeStore();
    configureSourceQuarantine(store);
    recordUnverifiedTeardown(new CommandTeardownError("pdftoppm teardown could not be verified: process group 1 still has members after 5000 ms"), "label=pdftoppm", { attribution });
    await flushSourceQuarantine();
    expect(records).toEqual([]);
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/status=source-not-listed reason=unattributable .*document=doc-1/);
  });

  it("an attributable failure lists the source for the configured time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("WORKER_SOURCE_QUARANTINE_TTL_HOURS", "12");
    const { store, records } = fakeStore();
    configureSourceQuarantine(store);
    recordUnverifiedTeardown(new CommandTeardownError("held", { attributable: true }), "label=pdftoppm", { attribution });
    await flushSourceQuarantine();
    expect(records).toEqual([{ documentId: "doc-1", ttlHours: 12 }]);
  });

  it.skipIf(!linux)("stdio held after the command's own processes are gone is attributable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const marker = path.join(scratch("docslurp-holder-"), "holder.pid");
    // A setsid'd descendant leaves the group holding stdout; the root exits once it has.
    const child = spawnContained(
      "/bin/sh",
      ["-c", `setsid sh -c 'echo $$ > ${marker}; exec sleep 30' & while [ ! -s ${marker} ]; do sleep 0.01; done; exit 0`],
      { env: process.env, containment: "process-group" },
    );
    child.stdout!.on("data", () => {});
    child.stderr!.on("data", () => {});
    const supervised = superviseChild(child, { label: "held", timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 300 } });
    const error = await supervised.done.catch((caught: unknown) => caught);
    strays.push(Number(readFileSync(marker, "utf8")));
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect((error as CommandTeardownError).attributable).toBe(true);
  }, 10_000);

  it.skipIf(!linux)("a child the runner refused (provider fault) is not attributable", async () => {
    silence();
    const refused: SandboxSession = {
      providerId: "claims-processes",
      isolation: { filesystem: true, network: "full", processes: true, location: "local" },
      spawn: (command) => spawnContained("/bin/sh", ["-c", "exit 0"], { env: command.env, containment: "process-group" }),
      close: async () => {},
    };
    const runner = new CommandRunner({ openSession: async () => refused });
    const error = await runner.run({ binary: "/bin/true", args: [], available: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect((error as CommandTeardownError).attributable).toBe(false);
  });
});

describe("Session close is bounded so a latched teardown still reaches Temporal", () => {
  it("closeSandboxQuietly returns at its bound when close never settles", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    await closeSandboxQuietly(() => new Promise<void>(() => {}), "activity=hung", 200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/status=close-timeout activity=hung timeout_ms=200/);
  });

  it("an activity whose teardown latched ends as the non-retryable teardown even if its session never closes", async () => {
    silence();
    vi.stubEnv("WORKER_SANDBOX_CLOSE_TIMEOUT_MS", "200");
    const hung: SandboxSession = {
      providerId: "hung-close",
      isolation: { filesystem: true, network: "full", processes: true, location: "local" },
      close: () => new Promise<void>(() => {}),
    };
    const environment = new MockActivityEnvironment({ activityId: "activity-6" });
    const interceptor = createSandboxActivityInterceptor(async () => hung)(environment.context).inbound!;
    const started = Date.now();
    const outcome = await environment.run(async () => {
      try {
        return await interceptor.execute!({ args: [], headers: {} }, (async () => {
          const { sandboxScopeStorage } = await import("../sandbox/session-context.js");
          await sandboxScopeStorage.getStore()!.get();
          recordUnverifiedTeardown(new CommandTeardownError("held"), "label=x");
          return "ok";
        }) as never);
      } catch (error) {
        return error;
      }
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toBeInstanceOf(ApplicationFailure);
    expect((outcome as ApplicationFailure).type).toBe(COMMAND_TEARDOWN_UNVERIFIED);
    expect((outcome as ApplicationFailure).nonRetryable).toBe(true);
  });
});
