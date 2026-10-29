import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { HungWorkError } from "../lib/hung-work.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import { markWorkerShuttingDown, resetWorkerShutdownForTests } from "../lib/worker-lifecycle.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createSandboxActivityInterceptor } from "../sandbox/activity-interceptor.js";
import { resolveCommandPaths } from "../sandbox/paths.js";
import bubblewrap from "../sandbox/providers/bubblewrap/index.js";
import { denyUnixSocketsFilter, ensureDenyUnixSocketsFilterFile } from "../sandbox/seccomp.js";
import { runWithSandboxScope, SandboxSessionScope } from "../sandbox/session-context.js";
import {
  admitCommandSource,
  configureSourceQuarantine,
  flushSourceQuarantine,
  QuarantinedSourceError,
  type SourceQuarantineStore,
} from "../sandbox/source-quarantine.js";
import {
  CommandTeardownError,
  probePidNamespace,
  recordUnverifiedTeardown,
  resetUnverifiedTeardownsForTests,
  spawnContained,
  type Containment,
} from "../sandbox/teardown.js";
import {
  quarantineForceExitMs,
  rethrowIfTeardown,
  scheduleQuarantineForceExit,
  WorkerQuarantinedError,
  workerShutdownForceMs,
} from "../sandbox/teardown-breaker.js";
import type { SandboxSession } from "../sandbox/types.js";
import {
  classifyActivityError,
  COMMAND_TEARDOWN_UNVERIFIED,
  interruptionFailure,
  WORKER_INTERRUPTED,
} from "../temporal/failure-classification.js";
import { CommandRunner, resolveScriptsDir } from "../tools/runner.js";
import { defaultPipelineFeatures } from "@docslurp/shared";
import type { Document, WorkspaceRun } from "../models.js";

// Reproduces the #234 round-5 council findings. Real processes where a process matters.
const linux = process.platform === "linux";
const pidNamespace = linux && probePidNamespace().ok;
const bwrapAvailable = linux && spawnSync("bwrap", ["--version"]).status === 0;

const roots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "unsettled"> {
  return Promise.race([
    promise.then((value) => ({ value }), (error: unknown) => ({ error })),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), ms)),
  ]);
}

beforeEach(() => {
  resetUnverifiedTeardownsForTests();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  configureSourceQuarantine(null);
  resetUnverifiedTeardownsForTests();
  resetWorkerShutdownForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function quickTeardown(): void {
  vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
  vi.stubEnv("WORKER_COMMAND_ABORT_GRACE_MS", "200");
  vi.stubEnv("WORKER_COMMAND_LAUNCHER_GRACE_MS", "200");
  vi.stubEnv("WORKER_COMMAND_TEARDOWN_VERIFY_MS", "500");
}

function containedSession(): SandboxSession {
  const containment: Containment = pidNamespace ? "pid-namespace" : "process-group";
  return {
    providerId: "none",
    isolation: { filesystem: false, network: "none", processes: pidNamespace, location: "local" },
    spawn: (command) => spawnContained(command.binary, command.args, { env: command.env, containment, init: true }),
    close: async () => {},
  };
}

/** A provider that claims PID isolation but starts a process-group child: always an unverified teardown. */
function refusedSession(): SandboxSession {
  return {
    providerId: "claims-processes",
    isolation: { filesystem: true, network: "full", processes: true, location: "local" },
    spawn: (command) => spawnContained("/bin/sh", ["-c", "exit 0"], { env: command.env, containment: "process-group" }),
    close: async () => {},
  };
}

function silence(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

/** Run `body` as an activity through the sandbox interceptor, with `session` as its sandbox. */
async function runActivity(
  session: SandboxSession,
  body: () => Promise<unknown>,
): Promise<{ value: unknown } | { error: unknown }> {
  const environment = new MockActivityEnvironment({ activityId: "activity-5" });
  const interceptor = createSandboxActivityInterceptor(async () => session)(environment.context).inbound!;
  return await environment.run(async (): Promise<{ value: unknown } | { error: unknown }> => {
    try {
      return { value: await interceptor.execute!({ args: [], headers: {} }, body as never) };
    } catch (error) {
      return { error };
    }
  });
}

function expectTeardownFailure(outcome: { value: unknown } | { error: unknown }): ApplicationFailure {
  expect(outcome).toHaveProperty("error");
  const failure = (outcome as { error: ApplicationFailure }).error;
  expect(failure).toBeInstanceOf(ApplicationFailure);
  expect(failure.type).toBe(COMMAND_TEARDOWN_UNVERIFIED);
  expect(failure.nonRetryable).toBe(true);
  return failure;
}

describe.skipIf(!linux)("H1: an activity whose command teardown failed always ends as a non-retryable teardown", () => {
  it("a real command's teardown failure swallowed by a parser fallback still fails the activity as teardown", async () => {
    quickTeardown();
    silence();
    const runner = new CommandRunner();
    const outcome = await runActivity(refusedSession(), async () => {
      try {
        await runner.run({ binary: "/bin/sh", args: [], available: true });
      } catch {
        // An optional sidecar or a fallback parser: old behavior returned success here.
      }
      return "fallback output";
    });
    const failure = expectTeardownFailure(outcome);
    expect(failure.cause).toBeInstanceOf(CommandTeardownError);
  }, 20_000);

  it("a watchdog interruption raised after the teardown failure is replaced by the teardown", async () => {
    silence();
    const outcome = await runActivity(containedSession(), async () => {
      recordUnverifiedTeardown(new CommandTeardownError("pandoc teardown could not be verified"), "label=pandoc");
      // What activities.ts produced for a stall or a shutdown: a retryable interruption.
      throw interruptionFailure(new HungWorkError("stage-stalled", "stage parse made no progress"));
    });
    expectTeardownFailure(outcome);
  });

  it("shutdown cancellation of a latched activity ends as teardown, not a retryable interruption", async () => {
    silence();
    const outcome = await runActivity(containedSession(), async () => {
      recordUnverifiedTeardown(new CommandTeardownError("tesseract teardown could not be verified"), "label=tesseract");
      markWorkerShuttingDown("teardown-unverified");
      throw new CancelledFailure("WORKER_SHUTDOWN");
    });
    expectTeardownFailure(outcome);
  });

  it("an activity without a latched teardown keeps its own outcome", async () => {
    expect(await runActivity(containedSession(), async () => "ok")).toEqual({ value: "ok" });
    const failed = await runActivity(containedSession(), async () => {
      throw new Error("model exploded");
    });
    expect(String((failed as { error: Error }).error)).toMatch(/model exploded/);
  });

  it("runner.launch: the latched activity gets its teardown, other activities a retryable interruption", async () => {
    quickTeardown();
    silence();
    vi.stubEnv("WORKER_UNVERIFIED_TEARDOWN_LIMIT", "1");
    const runner = new CommandRunner();
    let second: unknown;
    const latched = await runActivity(containedSession(), async () => {
      const first = new CommandTeardownError("pdftoppm teardown could not be verified");
      recordUnverifiedTeardown(first, "label=pdftoppm");
      second = await runner.run({ binary: "/bin/true", args: [], available: true }).catch((error: unknown) => error);
      return "done";
    });
    expect(second).toBeInstanceOf(CommandTeardownError);
    expectTeardownFailure(latched);
    // Another activity on the now-quarantined worker: refused by the interceptor before it runs.
    const other = await runActivity(containedSession(), async () => "never");
    expect((other as { error: ApplicationFailure }).error.type).toBe(WORKER_INTERRUPTED);
    // And a command outside any activity is refused with WorkerQuarantinedError (an interruption).
    const refused = await runner.run({ binary: "/bin/true", args: [], available: true }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkerQuarantinedError);
    expect(classifyActivityError(refused)).toBe("interruption");
    expect(isDocumentLevelFailure(refused)).toBe(false);
  });

  it("rethrowIfTeardown rethrows the latched teardown from a catch that saw another error", async () => {
    silence();
    const scope = new SandboxSessionScope(async () => containedSession());
    await runWithSandboxScope(scope, async () => {
      expect(() => rethrowIfTeardown(new Error("pdftoppm exited 1"))).not.toThrow();
      const teardown = new CommandTeardownError("x teardown could not be verified");
      recordUnverifiedTeardown(teardown, "label=x");
      expect(() => rethrowIfTeardown(new Error("pdftoppm exited 1"))).toThrow(teardown);
    });
    const quarantined = new QuarantinedSourceError("doc-1", "abc");
    expect(() => rethrowIfTeardown(new Error("wrapped", { cause: quarantined }))).toThrow("wrapped");
  });
});

function makeRun(): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload", status: "processing",
    stage: "extract-markdown", totalDocuments: 1, processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures }, error: null, stats: {}, artifacts: {}, claimId: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeDocument(): Document {
  return {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: "a.pdf", mimeType: "application/pdf", sourceKey: "raw/a.pdf",
    status: "queued", extractionMode: "hybrid", pageCount: 1, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe("H1: document checkpoints never retry or fail a Document over a teardown", () => {
  it.each([
    ["thrown", true],
    ["swallowed by the stage", false],
  ])("a teardown failure %s skips the remaining strategies and is rethrown", async (_label, thrown) => {
    silence();
    const state = WorkflowState.create(makeRun(), [makeDocument()]);
    const run = vi.fn(async (_strategy?: string) => {
      const teardown = new CommandTeardownError("pdftoppm teardown could not be verified");
      recordUnverifiedTeardown(teardown, "label=pdftoppm");
      if (thrown) throw teardown;
      return {};
    });
    const scope = new SandboxSessionScope(async () => containedSession());
    const error = await runWithSandboxScope(scope, () =>
      runDocumentStage(state, makeDocument(), "extract-markdown", "doc-1:markdown", "extracted", run, undefined, {
        retryStrategies: ["docling", "poppler-text"],
      })).catch((caught: unknown) => caught);
    // Old behavior: the next strategy ran (and in the swallowed case the stage completed).
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.documentStage("doc-1", "extract-markdown")?.status).not.toBe("failed");
    expect(state.documentStage("doc-1", "extract-markdown")?.status).not.toBe("completed");
  });

  it("a quarantined source fails the Document at once, without another strategy", async () => {
    silence();
    const state = WorkflowState.create(makeRun(), [makeDocument()]);
    const run = vi.fn(async () => {
      throw new QuarantinedSourceError("doc-1", "deadbeef");
    });
    await runDocumentStage(state, makeDocument(), "extract-markdown", "doc-1:markdown", "extracted", run, undefined, {
      retryStrategies: ["docling"],
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.documentStage("doc-1", "extract-markdown")?.status).toBe("failed");
  });
});

describe("M3: source quarantine", () => {
  function fakeStore(listed: Set<string>) {
    const records: Array<{ documentId: string; runId?: string; stage?: string }> = [];
    const store: SourceQuarantineStore = {
      async find(documentId) {
        return listed.has(documentId) ? { sourceSha256: `sha-${documentId}`, orgId: "org-1", workspaceId: "ws-1" } : null;
      },
      async record(entry) {
        records.push(entry);
        listed.add(entry.documentId);
        return { sourceSha256: `sha-${entry.documentId}`, orgId: "org-1", workspaceId: "ws-1" };
      },
    };
    return { store, records };
  }

  const inDocument = <T>(fn: () => Promise<T>) =>
    runWithPerfContext({ runId: "run-1", documentId: "doc-1", orgId: "org-1", workspaceId: "ws-1", scope: "document", stageName: "render-images", pushPerformance: () => {} }, fn);

  it("records the document of an unverified teardown, attributed, and refuses its source afterwards", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, records } = fakeStore(new Set());
    configureSourceQuarantine(store);
    await inDocument(async () => expect(admitCommandSource()).resolves.toBeUndefined());
    const teardown = new CommandTeardownError("pdftoppm teardown could not be verified");
    recordUnverifiedTeardown(teardown, "label=pdftoppm", {
      attribution: { org_id: "org-1", workspace_id: "ws-1", run_id: "run-1", document_id: "doc-1", stage: "render-images" },
    });
    await flushSourceQuarantine();
    expect(records).toEqual([{ documentId: "doc-1", runId: "run-1", stage: "render-images", detail: teardown.message }]);
    const logs = errors.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toMatch(/status=teardown-unverified .*org_id=org-1 workspace_id=ws-1 run_id=run-1 document_id=doc-1/);
    expect(logs).toMatch(/status=source-quarantined .*org=org-1 workspace=ws-1 run=run-1 document=doc-1 .*source_sha256=sha-doc-1/);
    // A new activity (another worker) refuses the document before any command.
    await inDocument(() => expect(admitCommandSource()).rejects.toBeInstanceOf(QuarantinedSourceError));
  });

  it("the runner refuses a command for a quarantined document", async () => {
    silence();
    const { store } = fakeStore(new Set(["doc-1"]));
    configureSourceQuarantine(store);
    const opened = vi.fn(async () => containedSession());
    const runner = new CommandRunner({ openSession: opened });
    const error = await inDocument(() => runner.run({ binary: "/bin/true", args: [], available: true })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QuarantinedSourceError);
    expect(opened).not.toHaveBeenCalled();
    expect(isDocumentLevelFailure(error)).toBe(true);
  });
});

describe("M3: concurrent raster lanes share no writable directory", () => {
  it("readOnlyInputs keeps the source's directory read-only and each lane writes only its own directory", () => {
    const source = path.join(scratch("docslurp-"), "docslurp-source-cache-x.pdf");
    writeFileSync(source, "%PDF");
    const raster = scratch("docslurp-raster-");
    const laneA = mkdtempSync(path.join(raster, "docslurp-page-"));
    const laneB = mkdtempSync(path.join(raster, "docslurp-page-"));
    const paths = (prefix: string, readOnlyInputs: boolean) =>
      resolveCommandPaths({
        plan: { binary: "pdftoppm", args: ["-png", "-f", "1", "-l", "1", "--", source, prefix], available: true, readOnlyInputs },
        venvBin: "/nonexistent/bin",
        scratchRoot: "/nonexistent/scratch",
        configuredWritablePaths: [],
        scriptsDir: resolveScriptsDir(),
      });
    const a = paths(path.join(laneA, "page-1-1"), true);
    const b = paths(path.join(laneB, "page-2-2"), true);
    expect(a.writablePaths).toEqual([laneA]);
    expect(b.writablePaths).toEqual([laneB]);
    expect(a.readablePaths).toContain(source);
    // Old behavior: the cached source's directory was writable by every lane of the document.
    expect(paths(path.join(laneA, "page-1-1"), false).writablePaths).toContain(path.dirname(source));
  });
});

describe("M3: UNIX-socket seccomp filter", () => {
  it("is generated for x64 and arm64 only", () => {
    expect(denyUnixSocketsFilter("x64")?.length).toBe(12 * 8);
    expect(denyUnixSocketsFilter("arm64")?.length).toBe(11 * 8);
    expect(denyUnixSocketsFilter("riscv64")).toBeNull();
    expect(() => ensureDenyUnixSocketsFilterFile(scratch("docslurp-seccomp-"), "riscv64")).toThrow(/refusing/);
  });

  const probe = [
    "import socket",
    "for name, make in (('unix', lambda: socket.socket(socket.AF_UNIX)), ('pair', lambda: socket.socketpair(socket.AF_UNIX)), ('inet', lambda: socket.socket(socket.AF_INET))):",
    "    try:",
    "        make(); print(name, 'ok')",
    "    except OSError as e:",
    "        print(name, e.errno)",
  ].join("\n");

  it.skipIf(!bwrapAvailable || !pidNamespace || process.arch !== "x64")("bubblewrap blocks socket(AF_UNIX) and socketpair for a command that asks", async () => {
    const root = scratch("docslurp-bwrap-seccomp-");
    const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
    const session = await bubblewrap.openSession(config, { activityId: "seccomp" });
    const runner = new CommandRunner({ openSession: async () => session });
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
    // bwrap cannot bind onto a symlinked binary (/usr/bin/python3 often is one).
    const plan = { binary: realpathSync("/usr/bin/python3"), args: ["-I", "-c", probe], available: true };
    const denied = await runner.run({ ...plan, denyUnixSockets: true });
    expect(denied.stdout.trim().split("\n")).toEqual(["unix 97", "pair 97", "inet ok"]);
    const allowed = await runner.run(plan);
    expect(allowed.stdout.trim().split("\n")).toEqual(["unix ok", "pair ok", "inet ok"]);
  }, 30_000);

  it.skipIf(!bwrapAvailable)("the launcher refuses a filter path outside the sandbox root or a symlinked one", () => {
    const root = scratch("docslurp-seccomp-launcher-");
    const sandboxRoot = path.join(root, "sandbox");
    const outside = ensureDenyUnixSocketsFilterFile(root);
    const launcher = path.join(resolveScriptsDir(), "parser-sandbox.sh");
    const run = (file: string) =>
      spawnSync("bash", [launcher, "/usr/bin/true"], {
        env: { PATH: process.env.PATH, DOCSLURP_PARSER_SANDBOX_ROOT: sandboxRoot, DOCSLURP_PARSER_SANDBOX_SECCOMP: file },
        encoding: "utf8",
      });
    expect(run(outside).stderr).toMatch(/refusing seccomp filter/);
    const link = path.join(sandboxRoot, "deny-unix-sockets-x64.bpf");
    mkdirSync(sandboxRoot, { recursive: true });
    symlinkSync(outside, link);
    const refused = run(link);
    expect(refused.status).toBe(70);
    expect(refused.stderr).toMatch(/refusing seccomp filter/);
  });
});

describe.skipIf(!linux)("M1: a successful command's destination cannot hold runToWritable forever", () => {
  it("a write that never calls back after a successful exit fails at the output deadline", async () => {
    quickTeardown();
    vi.stubEnv("WORKER_COMMAND_OUTPUT_FINISH_MS", "300");
    let closed = false;
    const runner = new CommandRunner({ openSession: async () => ({ ...containedSession(), close: async () => void (closed = true) }) });
    const stalled = new Writable({ highWaterMark: 1024, write() {} });
    const run = runner.runToWritable({ binary: "/bin/sh", args: ["-c", "head -c 512 /dev/zero"], available: true, timeoutMs: 500 }, stalled);
    run.catch(() => {});
    const outcome = await within(run, 8_000);
    // Old behavior (45064775): the exit cleared the wall-clock timer and the call never settled.
    expect(outcome).not.toBe("unsettled");
    expect((outcome as { error: Error }).error.name).toBe("CommandOutputTimeoutError");
    expect(closed).toBe(true);
  }, 15_000);

  it("a destination whose _final never calls back fails at the output deadline", async () => {
    quickTeardown();
    vi.stubEnv("WORKER_COMMAND_OUTPUT_FINISH_MS", "300");
    const runner = new CommandRunner({ openSession: async () => containedSession() });
    let received = 0;
    const stalledFinal = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback();
      },
      final() {},
      destroy(_error, callback) {
        // A destroy that never completes cannot hold the call either.
        void callback;
      },
    });
    const run = runner.runToWritable({ binary: "/bin/sh", args: ["-c", "printf hello"], available: true, timeoutMs: 400 }, stalledFinal);
    run.catch(() => {});
    const outcome = await within(run, 8_000);
    expect(outcome).not.toBe("unsettled");
    expect((outcome as { error: Error }).error.name).toBe("CommandOutputTimeoutError");
    expect(received).toBe(5);
  }, 15_000);

  it("the caller's abort ends the wait on a stalled destination after a successful exit", async () => {
    quickTeardown();
    const runner = new CommandRunner({ openSession: async () => containedSession() });
    const stalled = new Writable({ highWaterMark: 1024, write() {} });
    const controller = new AbortController();
    const run = runner.runToWritable({ binary: "/bin/sh", args: ["-c", "head -c 512 /dev/zero"], available: true, timeoutMs: 60_000 }, stalled, controller.signal);
    run.catch(() => {});
    setTimeout(() => controller.abort(new Error("activity cancelled")), 500);
    const outcome = await within(run, 8_000);
    expect(outcome).not.toBe("unsettled");
    expect(String((outcome as { error: Error }).error)).toMatch(/activity cancelled/);
  }, 15_000);
});

describe("L1: a quarantined worker always exits", () => {
  it("shutdownForceTime and the force-exit deadline cover the drain grace and teardown verification", () => {
    const timings = { graceMs: 2_000, launcherGraceMs: 1_000, verifyMs: 5_000, drainCapMs: 60_000 };
    expect(workerShutdownForceMs(240_000, timings)).toBe(255_000);
    expect(quarantineForceExitMs(240_000, timings)).toBe(285_000);
  });

  it("exits 1 with a [worker-fatal] force line once the deadline passes, on a timer that keeps the process alive", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const log = vi.fn();
    const timer = scheduleQuarantineForceExit(10_000, { exit, log });
    expect(timer.hasRef()).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^\[worker-fatal\] reason=teardown-unverified phase=force exiting=1/);
  });
});
