import { VM_TIMEOUT_MS, type DopplerVmJob } from "../sandbox/providers/modal/doppler-vm.js";
import { dopplerShardSettings, executeDopplerShards, type DopplerShardDeps } from "../sandbox/providers/modal/doppler-shards.js";
import { recordShardTimingInContext, type ShardCalibration } from "../pipeline/shard-calibration.js";
import { ensurePythonDistributions, parseMissingPythonDependency, parseMissingPythonModule } from "./python-deps.js";
import {
  ensureVendorBundle,
  findBundleForBinary,
  findBundleForPythonModule,
  vendorBundlesEnabled,
  type InstalledVendorBundle,
} from "./vendor-bundles.js";
import { withObservation } from "@docslurp/shared/observability";
import { DEFAULT_LOCAL_OCR_MODEL, DEFAULT_IMAGE_CLASSIFICATION_MODEL } from "@docslurp/shared";
import { existsSync, readFileSync, readdirSync, readlinkSync, lstatSync, realpathSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { platform } from "node:os";
import { pipeline } from "node:stream/promises";
import { finished } from "node:stream";
import type { Writable } from "node:stream";

import { resolveCommandPaths } from "../sandbox/paths.js";
import { latchedTeardownError, sandboxScopeStorage } from "../sandbox/session-context.js";
import { admitCommandSource } from "../sandbox/source-quarantine.js";
import { assertTeardownBreakerClosed } from "../sandbox/teardown-breaker.js";
import { defaultParserSandbox, registeredParserSandbox } from "../sandbox/startup.js";
import { SandboxPolicyError, SandboxRunError, type SandboxCommand, type SandboxResult, type SandboxSession } from "../sandbox/types.js";
import {
  CommandTeardownError,
  containmentOf,
  isCommandTeardownError,
  recordUnverifiedTeardown,
  spawnContained,
  superviseChild,
  teardownTimings,
  type SupervisedChild,
} from "../sandbox/teardown.js";
import { resolveScriptsDir } from "./scripts-dir.js";
import { createPool, type PythonPool } from "./python-pool.js";
import {
  buildAllowlistedEnv,
  defaultParserEnvAllowlist,
  defaultPythonPoolEnvAllowlist,
  vectorBackendEnvAllowlist,
} from "./process-env.js";
import { currentPerfContext, pushPerfMetric, pushUsageEvent } from "../lib/perf-context.js";
import { HungWorkError } from "../lib/hung-work.js";
import type { UsageEvent } from "../models.js";
import { noteWorkProgress, resolveCommandTimeoutMs } from "../lib/work-progress.js";
import {
  buildLocalComputeUsageEvent,
  resolveWorkerDeploymentProfile,
} from "../pipeline/local-compute-cost.js";

export interface CommandPlan {
  /** Fixed dedicated-VM job; dispatched before any local provider or backend. */
  dopplerVm?: DopplerVmJob;
  binary: string;
  args: string[];
  available: boolean;
  /** Page count for the wall-clock budget; defaults to the document in the perf context. */
  pages?: number;
  /** Explicit wall-clock budget, overriding the page-based one. */
  timeoutMs?: number;
  /** Vendor bundle (worker/vendor-bundles.json) that provides `binary`; fetched on first run. */
  vendorBundle?: string;
  /** Unpacked vendor bundles this command reads (bind-mounted read-only into the sandbox). */
  bundleRoots?: string[];
  /** site-packages directories prepended to PYTHONPATH (vendor bundles). */
  pythonPath?: string[];
  /** Extra environment from vendor bundles (worker/vendor-bundles.json `env`). */
  bundleEnv?: Record<string, string>;
  /**
   * Make creating a UNIX socket fail (bubblewrap's seccomp filter), so the command cannot meet a
   * concurrent command on a socket and pass file descriptors. Unset, it defaults to true for every
   * binary except the audited UNIX_SOCKET_CLIENTS. A local provider that cannot enforce it refuses
   * the command (see assertUnixSocketFilter).
   */
  denyUnixSockets?: boolean;
  /**
   * Existing file arguments are inputs only: their directories are not made writable. The command
   * writes only to the directories of its output arguments.
   */
  readOnlyInputs?: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  /**
   * Opens a sandbox session outside an activity scope. Omit to use the process default
   * (registered by the worker with setDefaultParserSandbox, else initialized from the env).
   */
  openSession?: (activityId: string) => Promise<SandboxSession>;
  /** Measured shard profiles (DB-backed); without it Doppler shards plan from the priors. */
  shardCalibration?: Pick<ShardCalibration, "profile">;
}

/** A started command: a local child process to monitor, or a remote run that completes on its own. */
export type LaunchedCommand =
  | { child: ChildProcess; supervised: SupervisedChild; release(): Promise<void> }
  | { remote: Promise<SandboxResult>; timeoutMs: number; release(): Promise<void> };

const DEFAULT_SCRATCH_ROOT = "/tmp/docslurp-parser-sandbox";

export interface DocumentToolInvocation {
  binary: string;
  args: string[];
  fileArgIndexes?: number[];
  supportsDoubleDash?: boolean;
}
type ProcessSample = {
  cpuPercent: number;
  rssKb: number;
  processCount: number;
};

const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
/** How often a pending remote command reports progress to the stage stall watchdog. */
const REMOTE_PROGRESS_INTERVAL_MS = 30_000;
export interface MalwareScanResult {
  engine: "clamscan" | "clamdscan" | null;
  available: boolean;
  status: "clean" | "infected" | "skipped-unavailable" | "error";
  signature: string | null;
  databaseStatus: "fresh" | "stale" | "missing" | "unknown";
  databaseUpdatedAt: string | null;
  databaseAgeHours: number | null;
  databaseSource: string | null;
  healthWarnings: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface MalwareScanPolicy {
  requireDaemon: boolean;
  failOpenOnStaleDefinitions: boolean;
  maxSignatureAgeHours: number;
  databaseDirectory: string;
}

export interface ClamDatabaseHealth {
  status: MalwareScanResult["databaseStatus"];
  updatedAt: string | null;
  ageHours: number | null;
  source: string | null;
}

export class CommandRunner {
  private readonly scriptsDir: string;
  private readonly venvBin: string;
  private readonly pythonBinary: string;
  private readonly commandRssBudgetKb: number | null;
  private readonly containerMemoryLimitMb: number | null;
  private readonly openSession?: (activityId: string) => Promise<SandboxSession>;
  private readonly shardCalibration?: Pick<ShardCalibration, "profile">;
  private readonly warmedCommands = new Set<string>();
  private embedPool?: PythonPool;

  constructor(options: CommandRunnerOptions = {}) {
    this.openSession = options.openSession;
    this.shardCalibration = options.shardCalibration;
    this.scriptsDir = resolveScriptsDir();
    this.venvBin = resolveVenvBin(process.env.PYTHON_VENV);
    const preferred = path.join(this.venvBin, "python3");
    this.pythonBinary = existsSync(preferred) ? preferred : "python3";
    this.containerMemoryLimitMb = detectContainerMemoryLimitMb();
    const commandRssBudgetMb = resolveCommandRssBudgetMb({
      explicitMb: readPositiveNumber(process.env.WORKER_COMMAND_MAX_RSS_MB),
      cgroupLimitMb: this.containerMemoryLimitMb,
    });
    this.commandRssBudgetKb = commandRssBudgetMb
      ? commandRssBudgetMb * 1024
      : null;

    if (this.commandRssBudgetKb) {
      console.log(
        `[worker-memory] container_limit_mb=${this.containerMemoryLimitMb ?? "unknown"} ` +
          `command_rss_budget_mb=${Math.round(this.commandRssBudgetKb / 1024)}`,
      );
    }
  }

  async plan(binary: string, ...args: string[]): Promise<CommandPlan> {
    const available = await this.isAvailable(binary);
    if (!available && !binary.includes(path.sep) && vendorBundlesEnabled()) {
      // A published, enabled vendor bundle can provide the binary; it is fetched when the plan runs.
      const vendorBundle = findBundleForBinary(binary);
      if (vendorBundle && vendorBundlesEnabled(process.env, vendorBundle)) return { binary, args, available: true, vendorBundle };
    }
    return { binary, args, available };
  }

  async summary(plan: CommandPlan): Promise<string> {
    return `${plan.binary} (${plan.available ? "available" : "missing"}) ${plan.args.join(" ")}`.trim();
  }

  async run(plan: CommandPlan, signal?: AbortSignal): Promise<CommandResult> {
    if (plan.vendorBundle) {
      // Throws VendorBundleUnavailableError (a clear, per-candidate failure) when it cannot be fetched.
      const bundle = await ensureVendorBundle(plan.vendorBundle, { signal });
      plan = withVendorBundle({ ...plan, binary: path.join(bundle.binDir, path.basename(plan.binary)), vendorBundle: undefined }, bundle);
    }
    try {
      return await this.runOnce(plan, signal);
    } catch (error) {
      if (!isPythonPlan(plan) || !(error instanceof Error) || signal?.aborted) throw error;
      // A Python extractor missing a module that a vendor bundle provides runs
      // again with that bundle on PYTHONPATH (see tools/vendor-bundles.ts).
      const missingModule = parseMissingPythonModule(error.message);
      const candidate = missingModule && vendorBundlesEnabled() ? findBundleForPythonModule(missingModule) : null;
      const bundleName = candidate && vendorBundlesEnabled(process.env, candidate) ? candidate : null;
      if (bundleName && !plan.bundleRoots?.length) {
        const bundle = await ensureVendorBundle(bundleName, { signal });
        return await this.run(withVendorBundle(plan, bundle), signal);
      }
      // Otherwise a lazy pip install into the venv (off in images; see tools/python-deps.ts).
      const missing = parseMissingPythonDependency(error.message);
      if (!missing) throw error;
      // The caller's timeout signal bounds the install too: an optional
      // extractor must never hold a stage hostage while pip or a lock waits.
      const installed = await ensurePythonDistributions([missing], { venvBin: this.venvBin, signal });
      if (!installed || signal?.aborted) throw error;
      return await this.runOnce(plan, signal);
    }
  }

  private async runOnce(plan: CommandPlan, signal?: AbortSignal): Promise<CommandResult> {
    return withObservation(
      {
        name: "worker.command",
        metadata: {
          binary: path.basename(plan.binary),
          script: plan.args
            .find((arg) => arg.endsWith(".py"))
            ?.split("/")
            .pop(),
        },
        result: (result) => ({
          metadata: {
            stdoutBytes: Buffer.byteLength(result.stdout),
            stderrBytes: Buffer.byteLength(result.stderr),
          },
        }),
      },
      async () => {
        const launched = await this.launch(plan, signal);
        try {
          if ("remote" in launched) {
            const result = await this.settleRemote(plan, launched);
            if (result.exitCode === 0) return { stdout: result.stdout, stderr: result.stderr };
            throw new Error(`${plan.binary} (${result.exitCode ?? "unknown"}): ${result.stderr || result.stdout}`.trim());
          }
          const { child, supervised } = launched;
          return await new Promise<CommandResult>((resolve, reject) => {
          const monitor = this.startCommandMonitor(plan, child, supervised);

          let stdout = "";
          let stderr = "";
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let outputLimitError: Error | null = null;
          const maxOutputBytes =
            readPositiveNumber(process.env.WORKER_COMMAND_MAX_OUTPUT_BYTES) ??
            DEFAULT_MAX_COMMAND_OUTPUT_BYTES;

          child.stdout!.on("data", (chunk) => {
            stdoutBytes += Buffer.byteLength(chunk);
            if (stdoutBytes > maxOutputBytes) {
              outputLimitError = new Error(
                `${plan.binary} stdout exceeded ${maxOutputBytes} bytes`,
              );
              supervised.terminate(outputLimitError, { immediate: true });
              return;
            }
            stdout += chunk.toString();
          });
          child.stderr!.on("data", (chunk) => {
            stderrBytes += Buffer.byteLength(chunk);
            if (stderrBytes > maxOutputBytes) {
              outputLimitError = new Error(
                `${plan.binary} stderr exceeded ${maxOutputBytes} bytes`,
              );
              supervised.terminate(outputLimitError, { immediate: true });
              return;
            }
            stderr += chunk.toString();
          });
          // Settles only after every process of the command is gone (see sandbox/teardown.ts).
          supervised.done.then(({ code, reason }) => {
            if (reason && reason.name === "AbortError") {
              reject(monitor.finish(code) ?? reason);
              return;
            }
            if (outputLimitError) {
              reject(outputLimitError);
              return;
            }
            const budgetError = monitor.finish(code);
            if (budgetError) {
              reject(budgetError);
              return;
            }
            if (code === 0) {
              resolve({ stdout, stderr });
              return;
            }

            reject(
              new Error(
                `${plan.binary} (${code ?? "unknown"}): ${stderr || stdout}`.trim(),
              ),
            );
          }, (error: Error) => reject(commandFailure(error, monitor.finish())));
          });
        } finally {
          await launched.release();
        }
      },
    );
  }

  async runToWritable(
    plan: CommandPlan,
    destination: Writable,
    signal?: AbortSignal,
  ): Promise<{ stderr: string }> {
    return withObservation(
      {
        name: "worker.command.stream",
        metadata: { binary: path.basename(plan.binary) },
      },
      async () => {
        const launched = await this.launch(plan, signal);
        try {
          if ("remote" in launched) {
            const result = await this.settleRemote(plan, launched);
            if (result.exitCode !== 0) {
              throw new Error(`${plan.binary} (${result.exitCode ?? "unknown"}): ${result.stderr}`.trim());
            }
            await pipeline(Readable.from([result.stdout]), destination);
            return { stderr: result.stderr };
          }
          return await this.streamToWritable(plan, launched.child, launched.supervised, destination, signal);
        } finally {
          await launched.release();
        }
      },
    );
  }

  private async streamToWritable(
    plan: CommandPlan,
    child: ChildProcess,
    supervised: SupervisedChild,
    destination: Writable,
    signal?: AbortSignal,
  ): Promise<{ stderr: string }> {
    const monitor = this.startCommandMonitor(plan, child, supervised);
    // The command's wall-clock deadline also bounds its output: the monitor stops counting when the
    // command exits, but the destination (an upload) must still finish by then, or within
    // WORKER_COMMAND_OUTPUT_FINISH_MS of the exit if that is later.
    const outputDeadlineAt = Date.now() + (plan.timeoutMs ?? resolveCommandTimeoutMs(plan.pages ?? currentPerfContext()?.pageCount));
    let stderr = "";
    let stderrBytes = 0;
    let outputLimitError: Error | null = null;
    const maxOutputBytes =
      readPositiveNumber(process.env.WORKER_COMMAND_MAX_OUTPUT_BYTES) ??
      DEFAULT_MAX_COMMAND_OUTPUT_BYTES;

    const exitPromise = new Promise<void>((resolve, reject) => {
      supervised.done.then(({ code, reason }) => {
        if (reason && reason.name === "AbortError") {
          reject(monitor.finish(code) ?? reason);
          return;
        }
        if (outputLimitError) {
          reject(outputLimitError);
          return;
        }
        const budgetError = monitor.finish(code);
        if (budgetError) {
          reject(budgetError);
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(
            `${plan.binary} (${code ?? "unknown"}): ${stderr}`.trim(),
          ),
        );
      }, (error: Error) => reject(commandFailure(error, monitor.finish())));
    });

    child.stderr!.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) {
        outputLimitError = new Error(
          `${plan.binary} stderr exceeded ${maxOutputBytes} bytes`,
        );
        supervised.terminate(outputLimitError, { immediate: true });
        return;
      }
      stderr += chunk.toString();
    });

    // Never fail fast: a destination failure (a full disk) stops the command, and the call settles
    // only after its teardown is verified. An unverified teardown wins over every other error.
    // The output is cancelled as soon as the command is being stopped (timeout, abort, budget) or
    // its root exits non-zero, and whenever the command's exit fails, so a destination that never
    // calls back (a stalled upload) can keep neither the command's stdio nor this call open. A
    // command that succeeded waits for its destination: a slow final upload part is legitimate.
    // Cancelling destroys only the destination. The command's stdout is unpiped and drained to its
    // real EOF: teardown verification counts only an EOF as closed stdio, never our own destroy.
    const source = child.stdout!;
    let outputSettled = false;
    let outputCancelled = false;
    let cancelReason: unknown = null;
    let onOutputCancelled: (() => void) | null = null;
    // Why we stopped waiting on a destination after a successful exit (deadline, caller abort).
    let outputStopError: Error | null = null;
    const discardRest = () => {
      source.unpipe(destination);
      source.resume();
    };
    const cancelOutput = (why: unknown) => {
      if (outputSettled || outputCancelled) return;
      outputCancelled = true;
      cancelReason = why;
      discardRest();
      const error = new Error("command output cancelled", { cause: why });
      error.name = "AbortError";
      destination.destroy(error);
      onOutputCancelled?.();
    };
    const piped = new Promise<void>((resolve, reject) => {
      finished(destination, (error) => {
        outputSettled = true;
        if (error) reject(error);
        else resolve();
      });
      // pipe() does not forward a source error; without this the destination would wait forever.
      source.once("error", (error) => cancelOutput(error));
      source.pipe(destination);
    }).catch((error: Error) => {
      discardRest();
      const failure = monitor.peekBudgetError() ?? error;
      if (!outputCancelled) supervised.terminate(failure, { immediate: true });
      throw failure;
    });
    // Observed now and awaited after the exit: it can settle first, and must not count as unhandled.
    piped.catch(() => {});
    const onTerminated = () => cancelOutput(supervised.terminated.reason);
    if (supervised.terminated.aborted) onTerminated();
    else supervised.terminated.addEventListener("abort", onTerminated, { once: true });
    void supervised.exited.then(({ code, signal }) => {
      if (code !== 0 || signal) cancelOutput(new Error(`${plan.binary} exited with ${code ?? signal}`));
    });
    const exit = await exitPromise.then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    supervised.terminated.removeEventListener("abort", onTerminated);
    if (exit.status === "rejected") cancelOutput(exit.reason);
    type Settled = { status: "fulfilled" } | { status: "rejected"; reason: unknown };
    const outputDone = piped.then(
      (): Settled => ({ status: "fulfilled" }),
      (reason: unknown): Settled => ({ status: "rejected", reason }),
    );
    // Bounded: a successful command's destination gets until the output deadline (and no longer
    // than the caller's signal); a cancelled destination gets OUTPUT_CANCEL_GRACE_MS to finish
    // destroying, so neither a stalled write nor a stalled _final or _destroy holds this call.
    const output = await new Promise<Settled>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      const onAbort = () => {
        outputStopError ??= abortReasonOf(signal!);
        cancelOutput(outputStopError);
      };
      const done = (value: Settled) => {
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        onOutputCancelled = null;
        resolve(value);
      };
      const armCancelGrace = () =>
        timers.push(setTimeout(() => done({ status: "rejected", reason: cancelReason }), OUTPUT_CANCEL_GRACE_MS));
      if (outputCancelled) armCancelGrace();
      else onOutputCancelled = armCancelGrace;
      if (exit.status === "fulfilled" && !outputSettled && !outputCancelled) {
        const waitMs = Math.max(outputDeadlineAt - Date.now(), outputFinishFloorMs());
        timers.push(setTimeout(() => {
          outputStopError ??= Object.assign(
            new Error(`${path.basename(plan.binary)} output did not finish within ${waitMs} ms after the command exited`),
            { name: "CommandOutputTimeoutError" },
          );
          cancelOutput(outputStopError);
        }, waitMs));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }
      void outputDone.then(done);
    });
    if (exit.status === "rejected" && isCommandTeardownError(exit.reason)) {
      throw commandFailure(exit.reason, output.status === "rejected" && !outputCancelled ? (output.reason as Error) : null);
    }
    // A successful command whose destination did not finish in time, or whose caller gave up on it.
    if (outputStopError) throw outputStopError;
    // The output failing first (a full disk) is the cause; its cancellation by a stopped or failed command is not.
    if (output.status === "rejected" && !(outputCancelled && exit.status === "rejected")) throw output.reason;
    if (exit.status === "rejected") throw exit.reason;

    return { stderr };
  }

  async pdfInfo(source: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfinfo",
      args: [source],
      fileArgIndexes: [0],
      supportsDoubleDash: true,
    });
  }

  async splitPages(source: string, pattern: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfseparate",
      args: [source, pattern],
      fileArgIndexes: [0, 1],
      supportsDoubleDash: true,
    });
  }

  async splitPdfPageRange(
    source: string,
    pattern: string,
    firstPage: number,
    lastPage: number,
  ): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfseparate",
      args: ["-f", String(firstPage), "-l", String(lastPage), source, pattern],
      fileArgIndexes: [4, 5],
      supportsDoubleDash: true,
    });
  }

  async extractPdfPageRange(
    source: string,
    output: string,
    range: string,
  ): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "qpdf",
      args: ["--empty", "--pages", source, range, "--", output],
      fileArgIndexes: [2, 5],
      supportsDoubleDash: false,
    });
  }

  async unitePdfs(sources: string[], output: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfunite",
      args: [...sources, output],
      fileArgIndexes: sources.map((_, index) => index).concat(sources.length),
      supportsDoubleDash: false,
    });
  }

  async renderPageImages(source: string, prefix: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdftoppm",
      args: ["-png", "-r", "150", source, prefix],
      fileArgIndexes: [3, 4],
      supportsDoubleDash: true,
    });
  }

  async renderPdfPageRange(
    source: string,
    prefix: string,
    firstPage: number,
    lastPage: number,
    dpi = 150,
    maxEdgePx = 4000,
  ): Promise<CommandPlan> {
    // pdfinfo reports CropBox size. Select that same box, and scale before
    // Splash allocates pixels rather than trusting DPI/metadata alone.
    if (!Number.isInteger(maxEdgePx) || maxEdgePx < 1 || maxEdgePx > 4000) {
      throw new Error("Invalid bounded PDF raster edge");
    }
    return await this.planDocumentTool({
      binary: "pdftoppm",
      args: [
        "-png",
        "-cropbox",
        "-scale-to",
        String(maxEdgePx),
        "-r",
        String(dpi),
        "-f",
        String(firstPage),
        "-l",
        String(lastPage),
        source,
        prefix,
      ],
      fileArgIndexes: [10, 11],
      supportsDoubleDash: true,
    });
  }

  async extractMarkdown(source: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pandoc",
      args: ["-t", "gfm", source],
      fileArgIndexes: [2],
      supportsDoubleDash: true,
    });
  }

  /** Private PDF tools execute only in a fresh, offline VM; never probe or load them on the host. */
  async dopplerMarkdown(source: string, output: string): Promise<CommandPlan> {
    if (!path.isAbsolute(source) || !path.isAbsolute(output) || source === output) {
      throw new Error("Doppler requires distinct absolute input and output paths");
    }
    if (!/^[^@]+@sha256:[0-9a-f]{64}$/.test(process.env.DOCSLURP_DOPPLER_VM_IMAGE ?? "")) {
      throw new Error("Doppler requires a digest-pinned DOCSLURP_DOPPLER_VM_IMAGE; refusing local fallback");
    }
    return { binary: "doppler-vm", args: [], available: true,
      dopplerVm: { operation: "doppler-markdown", input: source, output } };
  }

  async extractText(source: string, preservePageBreaks = false): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdftotext",
      args: [
        "-layout",
        "-enc",
        "UTF-8",
        "-eol",
        "unix",
        ...(preservePageBreaks ? [] : ["-nopgbrk"]),
        source,
        "-",
      ],
      fileArgIndexes: [preservePageBreaks ? 5 : 6],
      supportsDoubleDash: true,
    });
  }

  async extractHtml(source: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdftohtml",
      args: ["-stdout", "-hidden", "-nodrm", source],
      fileArgIndexes: [3],
      supportsDoubleDash: true,
    });
  }

  async extractImages(source: string, prefix: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfimages",
      args: ["-png", "-j", source, prefix],
      fileArgIndexes: [2, 3],
      supportsDoubleDash: true,
    });
  }

  /** Lists embedded images per page without decoding them (ingest report page facts). */
  async listImages(source: string, lastPage: number): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfimages",
      args: ["-list", "-l", String(Math.max(1, Math.trunc(lastPage))), source],
      fileArgIndexes: [3],
      supportsDoubleDash: true,
    });
  }

  /** `pdfimages -list` for a page range: one row per image drawn (size and placement ppi), no extraction. */
  async listPdfImages(source: string, firstPage: number, lastPage: number): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfimages",
      args: ["-list", "-f", String(firstPage), "-l", String(lastPage), source],
      fileArgIndexes: [5],
      supportsDoubleDash: true,
    });
  }

  /** `pdfinfo -f -l`: per-page size lines ("Page N size: W x H pts") for a page range. */
  async pdfPageSizes(source: string, firstPage: number, lastPage: number): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdfinfo",
      args: ["-f", String(firstPage), "-l", String(lastPage), source],
      fileArgIndexes: [4],
      supportsDoubleDash: true,
    });
  }

  /** Raw-order text layer with form-feed page breaks (ingest report page facts). */
  async pageText(source: string, lastPage: number): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdftotext",
      args: ["-l", String(Math.max(1, Math.trunc(lastPage))), "-enc", "UTF-8", "-eol", "unix", source, "-"],
      fileArgIndexes: [6],
      supportsDoubleDash: true,
    });
  }

  async ocrPdf(source: string, output: string): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "ocrmypdf",
      args: ["--skip-text", "--redo-ocr", source, output],
      fileArgIndexes: [2, 3],
      supportsDoubleDash: true,
    });
  }

  async unstructuredPartition(
    source: string,
    output: string,
    strategy: string,
  ): Promise<CommandPlan> {
    return await this.planScript(
      "python3",
      "unstructured_partition.py",
      "--input",
      source,
      "--output",
      output,
      "--strategy",
      strategy,
    );
  }

  // External comparison benchmarks only; Docling is not a production extractor or dependency.
  async doclingMarkdown(source: string, outdir: string): Promise<CommandPlan> {
    return await this.plan(
      "docling",
      "--from",
      "pdf",
      "--to",
      "md",
      "--output",
      outdir,
      source,
    );
  }

  async unpdfExtract(source: string, output: string): Promise<CommandPlan> {
    return await this.planScript(
      "node",
      "unpdf_extract.mjs",
      "--input",
      source,
      "--output",
      output,
    );
  }

  async kreuzbergMarkdown(
    source: string,
    output: string,
    configJson?: string,
  ): Promise<CommandPlan> {
    const args = ["--input", source, "--output", output];
    if (configJson) {
      args.push("--config-json", configJson);
    }
    return await this.planScript("node", "kreuzberg_extract.mjs", ...args);
  }

  async liteParseExtract(
    source: string,
    output: string,
    ocrEnabled = false,
  ): Promise<CommandPlan> {
    const args = ["--input", source, "--output", output];
    if (ocrEnabled) args.push("--ocr");
    return await this.planScript("node", "liteparse_extract.mjs", ...args);
  }

  async dolphinMarkdown(
    source: string,
    output: string,
    configJson?: string,
  ): Promise<CommandPlan> {
    const args = ["--input", source, "--output", output];
    if (configJson) {
      args.push("--config-json", configJson);
    }
    return await this.planScript("python3", "dolphin_extract.py", ...args);
  }

  async transformersJsClip(
    image: string,
    output: string,
    labels: string,
    model = process.env.DOCSLURP_CLIP_MODEL?.trim() || DEFAULT_IMAGE_CLASSIFICATION_MODEL,
  ): Promise<CommandPlan> {
    return await this.planScript(
      "node",
      "transformers_js_classify.mjs",
      "--image",
      image,
      "--output",
      output,
      "--labels",
      labels,
      "--model",
      model,
    );
  }

  async florence2(
    image: string,
    output: string,
    prompt: string,
    model = process.env.DOCSLURP_LOCAL_OCR_MODEL?.trim() || DEFAULT_LOCAL_OCR_MODEL,
  ): Promise<CommandPlan> {
    return await this.planScript(
      "python3",
      "florence2_extract.py",
      "--input",
      image,
      "--output",
      output,
      "--prompt",
      prompt,
      "--model",
      model,
    );
  }

  async writeVectorBackend(
    input: string,
    output: string,
    backend: string,
    collection: string,
  ): Promise<CommandPlan> {
    if (backend === "orama") {
      return await this.planScript(
        "node",
        "orama_write.mjs",
        "--input",
        input,
        "--output",
        output,
        "--collection",
        collection,
      );
    }

    return await this.planScript(
      "python3",
      "vector_backend_write.py",
      "--input",
      input,
      "--output",
      output,
      "--backend",
      backend,
      "--collection",
      collection,
    );
  }

  async trafilaturaExtract(
    source: string,
    output: string,
  ): Promise<CommandPlan> {
    return await this.planScript(
      "python3",
      "trafilatura_extract.py",
      "--input",
      source,
      "--output",
      output,
    );
  }

  async latexToMarkdown(source: string): Promise<CommandPlan> {
    return await this.plan("pandoc", "-f", "latex", "-t", "gfm", source);
  }

  async epubExtract(source: string, output: string): Promise<CommandPlan> {
    return await this.planScript(
      "python3",
      "epub_extract.py",
      "--input",
      source,
      "--output",
      output,
    );
  }

  async pptxExtract(source: string, output: string): Promise<CommandPlan> {
    return await this.planScript(
      "python3",
      "pptx_extract.py",
      "--input",
      source,
      "--output",
      output,
    );
  }

  async officeToPdf(source: string, outdir: string): Promise<CommandPlan> {
    return await this.plan(
      "soffice",
      "--headless",
      "--convert-to",
      "pdf",
      source,
      "--outdir",
      outdir,
    );
  }

  async mammothMarkdown(source: string, output: string): Promise<CommandPlan> {
    return await this.planScript(
      "node",
      "mammoth_extract.mjs",
      "--input",
      source,
      "--output",
      output,
      "--format",
      "markdown",
    );
  }

  async mammothHtml(source: string, output: string): Promise<CommandPlan> {
    return await this.planScript(
      "node",
      "mammoth_extract.mjs",
      "--input",
      source,
      "--output",
      output,
      "--format",
      "html",
    );
  }

  async xlsxToCsv(source: string, output: string): Promise<CommandPlan> {
    return await this.plan("xlsx2csv", "-a", source, output);
  }

  async xlsxExtractPy(
    source: string,
    output: string,
    options: { structureOnly?: boolean } = {},
  ): Promise<CommandPlan> {
    return await this.planScript(
      "python3",
      "xlsx_extract.py",
      "--input",
      source,
      "--output",
      output,
      ...(options.structureOnly ? ["--structure-only"] : []),
    );
  }

  async rtfToHtml(source: string): Promise<CommandPlan> {
    return await this.plan("unrtf", "--html", source);
  }

  async docToText(source: string): Promise<CommandPlan> {
    return await this.plan("catdoc", source);
  }

  async tesseractOcr(
    source: string,
    outputBase: string,
    langs?: string,
  ): Promise<CommandPlan> {
    const langArg = langs ?? "eng";
    return await this.plan(
      "tesseract",
      source,
      outputBase,
      "-l",
      langArg,
      "txt",
    );
  }

  async tiffSplit(source: string, outputPattern: string): Promise<CommandPlan> {
    return await this.plan("tiffcp", "-s", source, outputPattern);
  }

  async clamScan(source: string): Promise<CommandPlan> {
    return await this.plan("clamscan", "--no-summary", "--infected", source);
  }

  async clamDaemonScan(source: string): Promise<CommandPlan> {
    const configFile =
      process.env.DOCSLURP_CLAMAV_CLAMD_CONF?.trim() ||
      "/etc/clamav/clamd.conf";
    return await this.plan(
      "clamdscan",
      "--no-summary",
      "--fdpass",
      `--config-file=${configFile}`,
      source,
    );
  }

  async scanForMalware(
    source: string,
    signal?: AbortSignal,
  ): Promise<MalwareScanResult> {
    const policy = resolveMalwareScanPolicy();
    const databaseHealth = inspectClamDatabaseHealth(policy);
    const daemonPlan = await this.clamDaemonScan(source);
    const directPlan = await this.clamScan(source);
    const healthWarnings: string[] = [];

    const databaseWarning = describeClamDatabaseHealth(
      databaseHealth,
      policy.maxSignatureAgeHours,
    );
    const databaseBlocksScanning =
      (databaseHealth.status === "stale" ||
        databaseHealth.status === "missing") &&
      !policy.failOpenOnStaleDefinitions;

    if (databaseWarning && !databaseBlocksScanning) {
      healthWarnings.push(databaseWarning);
    }

    if (policy.requireDaemon && !daemonPlan.available) {
      return {
        engine: null,
        available: false,
        status: "error",
        signature: null,
        databaseStatus: databaseHealth.status,
        databaseUpdatedAt: databaseHealth.updatedAt,
        databaseAgeHours: databaseHealth.ageHours,
        databaseSource: databaseHealth.source,
        healthWarnings,
        stdout: "",
        stderr: "clamdscan is required but unavailable",
        exitCode: null,
      };
    }

    const selected = daemonPlan.available
      ? { engine: "clamdscan" as const, plan: daemonPlan }
      : directPlan.available
        ? { engine: "clamscan" as const, plan: directPlan }
        : null;

    if (!selected) {
      return {
        engine: null,
        available: false,
        status: "skipped-unavailable",
        signature: null,
        databaseStatus: databaseHealth.status,
        databaseUpdatedAt: databaseHealth.updatedAt,
        databaseAgeHours: databaseHealth.ageHours,
        databaseSource: databaseHealth.source,
        healthWarnings,
        stdout: "",
        stderr: "",
        exitCode: null,
      };
    }

    if (selected.engine === "clamscan" && daemonPlan.available === false) {
      healthWarnings.push("clamdscan unavailable, falling back to clamscan");
    }

    if (databaseBlocksScanning) {
      return {
        engine: selected.engine,
        available: true,
        status: "error",
        signature: null,
        databaseStatus: databaseHealth.status,
        databaseUpdatedAt: databaseHealth.updatedAt,
        databaseAgeHours: databaseHealth.ageHours,
        databaseSource: databaseHealth.source,
        healthWarnings,
        stdout: "",
        stderr: databaseWarning ?? "clamav signature database is unavailable",
        exitCode: null,
      };
    }

    const launched = await this.launch(selected.plan, signal);
    let outcome: SandboxResult;
    try {
      outcome =
        "remote" in launched
          ? await this.settleRemote(selected.plan, launched, "malware-scan")
          : await this.collectChild(selected.plan, launched.child, launched.supervised, "malware-scan");
    } finally {
      await launched.release();
    }
    const { exitCode: code, stdout, stderr } = outcome;
    const base = {
      engine: selected.engine,
      available: true as const,
      databaseStatus: databaseHealth.status,
      databaseUpdatedAt: databaseHealth.updatedAt,
      databaseAgeHours: databaseHealth.ageHours,
      databaseSource: databaseHealth.source,
      healthWarnings,
      stdout,
      stderr,
      exitCode: code,
    };
    if (code === 0) return { ...base, status: "clean", signature: null };
    if (code === 1) {
      return { ...base, status: "infected", signature: parseClamSignature(stdout) ?? parseClamSignature(stderr) };
    }
    return { ...base, status: "error", signature: null };
  }

  /** Run a monitored local child to completion; rejects on spawn errors and budget or timeout kills. */
  private collectChild(
    plan: CommandPlan,
    child: ChildProcess,
    supervised: SupervisedChild,
    metricPrefix: string,
  ): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolve, reject) => {
      const monitor = this.startCommandMonitor(plan, child, supervised, { metricPrefix });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      supervised.done.then(({ code, reason }) => {
        const budgetError = monitor.finish(code);
        if (budgetError) reject(budgetError);
        else if (reason) reject(reason);
        else resolve({ exitCode: code, stdout, stderr });
      }, (error: Error) => reject(commandFailure(error, monitor.finish())));
    });
  }

  async embedTextWithPool(args: {
    texts: string[];
    runtime: string;
    provider: string;
    model: string;
    dimensions: number;
    task?: string;
    batchSize: number;
    normalize: boolean;
    signal?: AbortSignal;
  }): Promise<{
    model: string;
    dimensions: number;
    vectors: number[][];
    usage?: Record<string, unknown>;
  }> {
    const pool = this.getEmbedPool();
    const workerId = await pool.acquire();

    try {
      return await pool.send(
        workerId,
        {
          mode: "embed",
          texts: args.texts,
          runtime: args.runtime,
          provider: args.provider,
          model: args.model,
          dimensions: args.dimensions,
          task: args.task ?? "document",
          batchSize: args.batchSize,
          normalize: args.normalize,
        },
        args.signal,
      );
    } finally {
      pool.release(workerId);
      noteWorkProgress("embed-pool");
    }
  }

  async close(): Promise<void> {
    if (this.embedPool) {
      await this.embedPool.shutdown();
      this.embedPool = undefined;
    }
  }

  async jsonExtract(
    source: string,
    output: string,
    chunkSize?: number,
  ): Promise<CommandPlan> {
    const args = ["--input", source, "--output", output];
    if (chunkSize !== undefined) args.push("--chunk-size", String(chunkSize));
    return await this.planScript("node", "json_extract.mjs", ...args);
  }

  private getEmbedPool(): PythonPool {
    if (!this.embedPool) {
      const size = Math.max(
        1,
        Number.parseInt(process.env.WORKER_PYTHON_POOL_SIZE ?? "2", 10) || 2,
      );
      const scriptPath = path.join(this.scriptsDir, "embed_text.py");
      this.embedPool = createPool(scriptPath, size, {
        binary: this.pythonBinary,
        args: ["--stdio-server"],
        env: buildAllowlistedEnv({
          defaultAllowlist: defaultPythonPoolEnvAllowlist,
          allowlistEnvVar: "DOCSLURP_PYTHON_POOL_ENV_ALLOWLIST",
          overrides: {
            PATH: `${this.venvBin}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        }),
      });
    }

    return this.embedPool;
  }

  async videoScan(source: string, duration: number, fps: number): Promise<CommandPlan> {
    const plan = await this.planScript("python3", "video_scan.py", "--source", source, "--duration", String(duration), "--fps", String(fps));
    plan.timeoutMs = 300000;
    return plan;
  }

  private async planScript(
    binary: string,
    script: string,
    ...args: string[]
  ): Promise<CommandPlan> {
    const resolvedBinary = binary === "python3" ? this.pythonBinary : binary;
    const scriptPath = path.join(this.scriptsDir, script);
    const plan = await this.plan(resolvedBinary, scriptPath, ...args);

    try {
      await access(scriptPath);
      return plan;
    } catch {
      return { ...plan, available: false };
    }
  }

  private async planDocumentTool(
    invocation: DocumentToolInvocation,
  ): Promise<CommandPlan> {
    const planned = planDocumentToolInvocation(invocation);
    return await this.plan(planned.binary, ...planned.args);
  }

  private async isAvailable(binary: string): Promise<boolean> {
    if (binary.includes(path.sep)) {
      try {
        await access(binary);
        return true;
      } catch {
        return false;
      }
    }

    const paths = (process.env.PATH ?? "").split(path.delimiter);
    for (const base of [this.venvBin, ...paths]) {
      if (!base) {
        continue;
      }
      try {
        await access(path.join(base, binary));
        return true;
      } catch {}
    }
    return false;
  }

  private async acquireSession(): Promise<{ session: SandboxSession; release(): Promise<void> }> {
    const scope = sandboxScopeStorage.getStore();
    if (scope) return { session: await scope.get(), release: async () => {} };
    // Outside an activity scope (CLIs, tests): one short-lived session per command.
    const open = this.openSession
      ? (id: string) => this.openSession!(id)
      : async (id: string) => {
          const { provider, config } = await defaultParserSandbox();
          return provider.openSession(config, { activityId: id });
        };
    const session = await open("command");
    return { session, release: () => session.close() };
  }

  /**
   * Scratch and writable inputs come from the provider config when it declares them, else from
   * the shared env vars. A runner with its own opener never initializes a provider just for this.
   */
  private async sandboxPathConfig(): Promise<{ scratchRoot: string; writablePaths: string[] }> {
    const sandbox = registeredParserSandbox() ?? (this.openSession ? undefined : await defaultParserSandbox());
    const config = sandbox?.config as { scratchRoot?: unknown; writablePaths?: unknown } | undefined;
    const scratchRoot =
      typeof config?.scratchRoot === "string"
        ? config.scratchRoot
        : process.env.DOCSLURP_PARSER_SANDBOX_ROOT?.trim() || DEFAULT_SCRATCH_ROOT;
    const writablePaths = Array.isArray(config?.writablePaths)
      ? (config.writablePaths as string[])
      : (process.env.DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    return { scratchRoot, writablePaths };
  }

  /**
   * Start a command through the activity's sandbox session. Vector-writer commands hold
   * backend credentials and run outside the sandbox. Callers must `release()` when done.
   */
  private dopplerShardDeps(): DopplerShardDeps {
    const calibration = this.shardCalibration;
    return {
      ...(calibration ? { profile: () => calibration.profile("extract-markdown:doppler-vm") } : {}),
      recordTiming: (timing) => recordShardTimingInContext(timing),
    };
  }

  async launch(plan: CommandPlan, signal?: AbortSignal): Promise<LaunchedCommand> {
    await admitCommand();
    if (plan.dopplerVm) {
      // DOCSLURP_DOPPLER_SHARDS=on fans long PDFs out across parallel VMs (needs a doppler-vm@3 image).
      const settings = dopplerShardSettings();
      const pages = plan.pages ?? currentPerfContext()?.pageCount ?? 0;
      const waves = settings.enabled ? Math.ceil(settings.maxShards / settings.vmParallel) + 1 : 1;
      return {
        remote: executeDopplerShards(plan.dopplerVm, pages, signal, settings, this.dopplerShardDeps()),
        timeoutMs: VM_TIMEOUT_MS * waves,
        release: async () => {},
      };
    }
    if (isVectorBackendCommand(plan.args, this.scriptsDir)) {
      const env = buildCommandEnv({ plan, venvBin: this.venvBin, isVectorBackend: true });
      // Trusted code that holds backend credentials, not a parser: a process group is enough.
      const child = spawnContained(plan.binary, plan.args, { env, containment: "process-group" });
      return { child, supervised: superviseCommand(plan, child, signal), release: async () => {} };
    }
    const { scratchRoot, writablePaths } = await this.sandboxPathConfig();
    const pages = plan.pages ?? currentPerfContext()?.pageCount;
    const command = buildSandboxCommand({
      plan,
      venvBin: this.venvBin,
      scriptsDir: this.scriptsDir,
      scratchRoot,
      configuredWritablePaths: writablePaths,
      limits: {
        timeoutMs: plan.timeoutMs ?? resolveCommandTimeoutMs(pages),
        ...(this.commandRssBudgetKb ? { rssBudgetMb: Math.round(this.commandRssBudgetKb / 1024) } : {}),
      },
    });
    const { session, release } = await this.acquireSession();
    try {
      if (session.spawn) {
        assertProcessTeardown(session);
        assertUnixSocketFilter(session, command);
        const child = session.spawn(command);
        const containment = containmentOf(child);
        if (containment !== "pid-namespace" && !(containment && allowsUnisolated(session))) {
          const refusal = new SandboxPolicyError(
            `parser sandbox provider '${session.providerId}' started a command ` +
              `${containment ? `with ${containment} containment instead of a PID namespace` : "without process containment"}; refusing to run it`,
          );
          await stopRefusedChild(plan, child, containment !== undefined, refusal);
        }
        return { child, supervised: superviseCommand(plan, child, signal), release };
      }
      if (session.run) {
        // Only a remote session (its own VM, terminated with the activity) may skip process
        // containment and the socket filter; a local provider offering `run` would run unchecked.
        if (session.isolation.location !== "remote") {
          throw new SandboxPolicyError(
            `parser sandbox provider '${session.providerId}' offers run() but is not remote; refusing to run a command it does not contain`,
          );
        }
        return { remote: session.run(command, signal), timeoutMs: command.limits.timeoutMs, release };
      }
      throw new Error(`Sandbox session '${session.providerId}' offers neither spawn nor run`);
    } catch (error) {
      await release();
      throw error;
    }
  }

  /**
   * Await a remote run in place of the local monitor: report progress to the stall watchdog
   * while it is pending (up to its time limit), record the provider's usage event in the
   * caller's usage scope, and apply the same output cap as local commands.
   */
  async settleRemote(
    plan: CommandPlan,
    launched: { remote: Promise<SandboxResult>; timeoutMs: number },
    metricPrefix = "command",
  ): Promise<SandboxResult> {
    const startedAt = Date.now();
    // Bound to this stage's async context so the note reaches its progress tracker.
    const progress = setInterval(AsyncResource.bind(() => {
      if (Date.now() - startedAt > launched.timeoutMs) clearInterval(progress);
      else noteWorkProgress(`command:${path.basename(plan.binary)}`);
    }), REMOTE_PROGRESS_INTERVAL_MS);
    progress.unref();
    let result: SandboxResult;
    try {
      result = await launched.remote;
    } catch (error) {
      if (error instanceof SandboxRunError && error.usage) recordRemoteUsage(error.usage);
      throw error;
    } finally {
      clearInterval(progress);
    }
    if (result.usage) recordRemoteUsage(result.usage);
    noteWorkProgress(`command-exit:${path.basename(plan.binary)}`);
    const context = currentPerfContext();
    if (context) {
      const metadata = { binary: plan.binary, exitCode: result.exitCode, measurement: "provider-reported" };
      const tags = ["process", "subprocess", "remote", context.scope];
      pushPerfMetric({ metric: `${metricPrefix}-duration`, value: Date.now() - startedAt, unit: "ms", tags, metadata });
      if (result.cpuSeconds !== undefined) {
        pushPerfMetric({ metric: `${metricPrefix}-cpu-time`, value: roundMetric(result.cpuSeconds), unit: "second", tags, metadata });
      }
      if (result.peakRssKb !== undefined) {
        pushPerfMetric({
          metric: `${metricPrefix}-rss-peak`,
          value: roundMetric(result.peakRssKb / 1024),
          unit: "mb",
          tags,
          metadata,
        });
      }
    }
    const maxOutputBytes = readPositiveNumber(process.env.WORKER_COMMAND_MAX_OUTPUT_BYTES) ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
    for (const stream of ["stdout", "stderr"] as const) {
      if (Buffer.byteLength(result[stream]) > maxOutputBytes) {
        throw new Error(`${plan.binary} ${stream} exceeded ${maxOutputBytes} bytes`);
      }
    }
    return result;
  }

  private startCommandMonitor(
    plan: CommandPlan,
    child: ReturnType<typeof spawn>,
    supervised: SupervisedChild,
    options?: { metricPrefix?: string },
  ) {
    const context = currentPerfContext();
    const startedAt = Date.now();
    const sampleEveryMs = 250;
    const pid = child.pid;
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    let peakCpuPercent = 0;
    let peakRssKb = 0;
    let peakProcessCount = 0;
    let budgetError: Error | null = null;
    // Wall-clock budget (OP-08): pages x per-page, hard max. A hung parser is
    // killed and fails as hung work instead of holding the slot for hours.
    const pages = plan.pages ?? context?.pageCount;
    const timeoutMs = plan.timeoutMs ?? resolveCommandTimeoutMs(pages);
    let timeoutError: Error | null = null;
    const wallClockTimer = pid
      ? setTimeout(() => {
          if (finished || budgetError) return;
          timeoutError = new HungWorkError(
            "command-timeout",
            `${path.basename(plan.binary)} exceeded its ${Math.round(timeoutMs / 1000)} s wall-clock budget ` +
              `(${pages ?? "unknown"} pages)`,
          );
          console.error(
            `[worker-command] status=timeout binary=${plan.binary} timeout_ms=${timeoutMs} pages=${pages ?? "unknown"} pid=${pid}`,
          );
          // The same verified teardown as an abort: TERM, then KILL, settling once all of it is gone.
          supervised.terminate(timeoutError);
        }, timeoutMs)
      : undefined;
    wallClockTimer?.unref?.();
    const metricPrefix = options?.metricPrefix ?? "command";
    const commandKey = plan.binary;
    const cold = !this.warmedCommands.has(commandKey);
    let sampledCpuSeconds = 0;
    let sampledMemoryGbSeconds = 0;
    let lastSampleAt = startedAt;

    const sample = async () => {
      if (!pid) {
        return;
      }
      const snapshot = await inspectProcessTree(pid);
      if (!snapshot) {
        return;
      }
      const sampledAt = Date.now();
      const elapsedSeconds = Math.max(0, sampledAt - lastSampleAt) / 1000;
      sampledCpuSeconds += (snapshot.cpuPercent / 100) * elapsedSeconds;
      sampledMemoryGbSeconds +=
        ((snapshot.rssKb * 1024) / 1024 ** 3) * elapsedSeconds;
      lastSampleAt = sampledAt;
      peakCpuPercent = Math.max(peakCpuPercent, snapshot.cpuPercent);
      // A subprocess burning CPU is progress; a deadlocked one is not.
      if (snapshot.cpuPercent >= 1) noteWorkProgress(`command:${path.basename(plan.binary)}`);
      peakRssKb = Math.max(peakRssKb, snapshot.rssKb);
      peakProcessCount = Math.max(peakProcessCount, snapshot.processCount);

      if (
        this.commandRssBudgetKb &&
        snapshot.rssKb > this.commandRssBudgetKb &&
        budgetError === null
      ) {
        budgetError = new Error(
          `${plan.binary} exceeded subprocess RSS budget ` +
            `(${formatMemoryMb(snapshot.rssKb)} MiB > ${formatMemoryMb(this.commandRssBudgetKb)} MiB)`,
        );
        console.error(
          `[worker-memory] status=budget-exceeded binary=${plan.binary} ` +
            `rss_mb=${formatMemoryMb(snapshot.rssKb)} limit_mb=${formatMemoryMb(this.commandRssBudgetKb)} ` +
            `pid=${pid} args=${JSON.stringify(plan.args)}`,
        );
        supervised.terminate(budgetError, { immediate: true });
      }
    };

    if (pid) {
      void sample();
      timer = setInterval(() => {
        void sample();
      }, sampleEveryMs);
    }

    return {
      peekBudgetError: () => budgetError ?? timeoutError,
      finish: (exitCode?: number | null) => {
        if (finished) {
          return budgetError ?? timeoutError;
        }
        finished = true;
        if (timer) {
          clearInterval(timer);
        }
        if (wallClockTimer) clearTimeout(wallClockTimer);
        noteWorkProgress(`command-exit:${path.basename(plan.binary)}`);
        this.warmedCommands.add(commandKey);
        if (!context) {
          return budgetError ?? timeoutError;
        }
        const durationMs = Date.now() - startedAt;
        const durationSeconds = durationMs / 1000;
        const cpuSeconds =
          sampledCpuSeconds > 0
            ? sampledCpuSeconds
            : Math.min(durationSeconds, 0.005);
        const memoryGbSeconds =
          sampledMemoryGbSeconds > 0
            ? sampledMemoryGbSeconds
            : ((peakRssKb * 1024) / 1024 ** 3) * durationSeconds;
        const deploymentProfile = resolveWorkerDeploymentProfile();
        pushPerfMetric({
          metric: `${metricPrefix}-duration`,
          value: durationMs,
          unit: "ms",
          tags: ["process", "subprocess", context.scope],
          metadata: {
            binary: plan.binary,
            args: plan.args,
            pid: pid ?? null,
            exitCode: exitCode ?? null,
          },
        });
        pushPerfMetric({
          metric: `${metricPrefix}-cpu-time`,
          value: roundMetric(cpuSeconds),
          unit: "second",
          tags: [
            "process",
            "cpu",
            "subprocess",
            context.scope,
            cold ? "cold" : "warm",
          ],
          metadata: {
            binary: plan.binary,
            measurement: sampledCpuSeconds > 0 ? "sampled" : "startup-floor",
            deploymentProfile: deploymentProfile.id,
          },
        });
        pushPerfMetric({
          metric: `${metricPrefix}-memory-time`,
          value: roundMetric(memoryGbSeconds),
          unit: "gb-second",
          tags: [
            "process",
            "memory",
            "subprocess",
            context.scope,
            cold ? "cold" : "warm",
          ],
          metadata: {
            binary: plan.binary,
            measurement:
              sampledMemoryGbSeconds > 0 ? "sampled" : "peak-rss-proxy",
            deploymentProfile: deploymentProfile.id,
          },
        });
        pushUsageEvent(
          buildLocalComputeUsageEvent({
            metric: "parser-process",
            profile: deploymentProfile,
            costRollup: "included",
            observation: {
              cpuSeconds,
              memoryGbSeconds,
              wallTimeMs: durationMs,
              cold,
            },
            metadata: {
              binary: plan.binary,
              exitCode: exitCode ?? null,
              cpuMeasurement:
                sampledCpuSeconds > 0 ? "sampled" : "startup-floor",
              memoryMeasurement:
                sampledMemoryGbSeconds > 0 ? "sampled" : "peak-rss-proxy",
            },
          }),
        );
        if (peakCpuPercent > 0) {
          pushPerfMetric({
            metric: `${metricPrefix}-cpu-peak`,
            value: roundMetric(peakCpuPercent),
            unit: "percent",
            tags: ["process", "cpu", "subprocess", context.scope],
            metadata: {
              binary: plan.binary,
              args: plan.args,
            },
          });
        }
        if (peakRssKb > 0) {
          pushPerfMetric({
            metric: `${metricPrefix}-rss-peak`,
            value: peakRssKb,
            unit: "kb",
            tags: ["process", "memory", "rss", "subprocess", context.scope],
            metadata: {
              binary: plan.binary,
              args: plan.args,
            },
          });
        }
        if (peakProcessCount > 0) {
          pushPerfMetric({
            metric: `${metricPrefix}-process-count-peak`,
            value: peakProcessCount,
            unit: "count",
            tags: ["process", "subprocess", "fanout", context.scope],
            metadata: {
              binary: plan.binary,
              args: plan.args,
            },
          });
        }
        if (budgetError && this.commandRssBudgetKb) {
          pushPerfMetric({
            metric: `${metricPrefix}-rss-budget-exceeded`,
            value: peakRssKb || this.commandRssBudgetKb,
            unit: "kb",
            tags: ["process", "memory", "rss", "budget", context.scope],
            metadata: {
              binary: plan.binary,
              args: plan.args,
              budgetKb: this.commandRssBudgetKb,
              pid: pid ?? null,
              exitCode: exitCode ?? null,
            },
          });
        }
        return budgetError ?? timeoutError;
      },
    };
  }
}

function parsePsRow(
  line: string,
): { pid: number; ppid: number; rssKb: number; cpuPercent: number } | null {
  const parts = line.trim().split(/\s+/, 4);
  if (parts.length !== 4) {
    return null;
  }
  const pid = Number.parseInt(parts[0] ?? "", 10);
  const ppid = Number.parseInt(parts[1] ?? "", 10);
  const rssKb = Number.parseInt(parts[2] ?? "", 10);
  const cpuPercent = Number.parseFloat(parts[3] ?? "");
  if (
    !Number.isFinite(pid) ||
    !Number.isFinite(ppid) ||
    !Number.isFinite(rssKb) ||
    !Number.isFinite(cpuPercent)
  ) {
    return null;
  }
  return { pid, ppid, rssKb, cpuPercent };
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

type ProcessTreeSnapshot = ProcessSample & {
  pids: number[];
};

async function inspectProcessTree(
  rootPid: number,
): Promise<ProcessTreeSnapshot | null> {
  const procPlatform = platform();
  if (procPlatform !== "darwin" && procPlatform !== "linux") {
    return null;
  }

  return await new Promise((resolve) => {
    const ps = spawn("ps", ["-axo", "pid=,ppid=,rss=,%cpu="], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";
    ps.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    ps.on("error", () => resolve(null));
    ps.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const rows = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parsePsRow)
        .filter(
          (
            row,
          ): row is {
            pid: number;
            ppid: number;
            rssKb: number;
            cpuPercent: number;
          } => row !== null,
        );

      const descendants = new Set<number>([rootPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
            descendants.add(row.pid);
            changed = true;
          }
        }
      }

      let rssKb = 0;
      let cpuPercent = 0;
      let processCount = 0;
      for (const row of rows) {
        if (!descendants.has(row.pid)) {
          continue;
        }
        processCount += 1;
        rssKb += row.rssKb;
        cpuPercent += row.cpuPercent;
      }

      resolve(
        processCount > 0
          ? { rssKb, cpuPercent, processCount, pids: Array.from(descendants) }
          : null,
      );
    });
  });
}

/**
 * Untrusted parser work needs a provider that guarantees every process a command starts dies with it
 * (a PID namespace). Without one, a parser's descendant can outlive the command, its slot and its
 * scratch. Refuse loudly, unless this is the explicitly unisolated `none` mode.
 */
/**
 * The error a failed command rejects with. An unverified teardown always wins over whatever was
 * stopping the command (a timeout, a budget, a failed destination), so its slot stays poisoned;
 * that error rides along as its cause.
 */
function commandFailure(error: unknown, stopping: Error | null): Error {
  if (isCommandTeardownError(error)) {
    if (stopping && stopping !== error && error.cause === undefined) {
      Object.defineProperty(error, "cause", { value: stopping, configurable: true, writable: true });
    }
    return error;
  }
  return stopping ?? (error as Error);
}

/** Only provider none, with the explicit override, may run parser work without a PID namespace. */
function allowsUnisolated(session: SandboxSession): boolean {
  return session.providerId === "none" && process.env.DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED === "true";
}

/**
 * Stop a child the runner refuses to run. It always ends in CommandTeardownError (cause: the
 * refusal): it was refused because its containment cannot prove that its processes are gone (a
 * setsid'd descendant leaves the process group, and an uncontained child has no group we own), so
 * root exit or an empty group proves nothing. Its slot is poisoned, its scratch is kept for the
 * sweep, and the worker's teardown circuit breaker counts it.
 */
async function stopRefusedChild(plan: CommandPlan, child: ChildProcess, contained: boolean, refusal: Error): Promise<never> {
  const label = path.basename(plan.binary);
  if (contained) {
    const supervised = superviseCommand(plan, child, undefined, `${label} was refused (${refusal.message}); its teardown cannot be proven`);
    supervised.terminate(refusal, { immediate: true });
    try {
      await supervised.done;
    } catch (error) {
      throw commandFailure(error, refusal);
    }
    // superviseChild never resolves an unprovable command; fail closed if that ever changes.
    const error = new CommandTeardownError(`${label} (refused) teardown could not be verified`, { cause: refusal });
    recordUnverifiedTeardown(error, `label=${label} containment=${containmentOf(child)}`, { attribution: commandAttribution() });
    throw error;
  }
  // Not ours to supervise: kill its group (if it was spawned detached) and itself, and wait (bounded) for its exit.
  let detail = "it was started without process containment, so no descendant of it can be proven gone";
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* not a group leader */
    }
    child.kill("SIGKILL");
    const { verifyMs } = teardownTimings();
    let timer: NodeJS.Timeout | undefined;
    const gone = await Promise.race([exited, new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), verifyMs)))]);
    clearTimeout(timer);
    if (!gone) detail = `it did not exit within ${verifyMs} ms of SIGKILL`;
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  const error = new CommandTeardownError(`${label} (refused, uncontained) teardown could not be verified: ${detail}`, { cause: refusal });
  recordUnverifiedTeardown(error, `label=${label} pid=${child.pid} containment=none`, { attribution: commandAttribution() });
  throw error;
}

function assertProcessTeardown(session: SandboxSession): void {
  if (session.isolation.processes) return;
  if (allowsUnisolated(session)) return;
  console.error(
    `[parser-sandbox] status=refused provider=${session.providerId} reason=no-process-teardown ` +
      "detail=provider cannot guarantee a parser's descendants die with it",
  );
  throw new SandboxPolicyError(
    `parser sandbox provider '${session.providerId}' cannot guarantee that a command's processes die with it ` +
      "(no PID namespace); refusing untrusted parser work",
  );
}

/**
 * Binaries that may need a UNIX socket, so they run without the AF_UNIX filter (sandbox/seccomp.ts);
 * every other command gets it. Audited 2026-10-29 against every binary the runner plans:
 * - clamdscan talks to clamd over its LocalSocket.
 * - LibreOffice (soffice, soffice.bin, libreoffice, unoconv) uses one for its own IPC.
 * - Python interpreters and Python entry points (docling, ocrmypdf, xlsx2csv): asyncio's self-pipe
 *   and multiprocessing (forkserver, Manager, duplex Pipe) use socketpair(AF_UNIX).
 * - node: libuv's child-process stdio and IPC use socketpair(AF_UNIX).
 * - kreuzberg: a tokio runtime's signal driver uses a UNIX socket pair.
 * Poppler, qpdf, tesseract, pandoc, unrtf, catdoc, tiffcp and clamscan do not use one. A tool not
 * listed here gets the filter: add it only after checking that it needs a socket.
 */
const UNIX_SOCKET_CLIENTS = new Set([
  "clamdscan", "soffice", "soffice.bin", "libreoffice", "unoconv",
  "docling", "ocrmypdf", "xlsx2csv", "node", "kreuzberg",
]);

export function needsUnixSockets(binary: string): boolean {
  const name = path.basename(binary);
  return UNIX_SOCKET_CLIENTS.has(name) || /^python[0-9.]*$/.test(name);
}

/** Commands that must not create a UNIX socket, unless the plan says otherwise. */
export function deniesUnixSockets(plan: Pick<CommandPlan, "binary" | "denyUnixSockets">): boolean {
  return plan.denyUnixSockets ?? !needsUnixSockets(plan.binary);
}

let warnedUnfilteredSockets = false;

/**
 * A local provider that cannot enforce the AF_UNIX filter (landlock, none) must not run a command
 * that asks for it: two such commands could meet on a socket and trip the teardown breaker, or
 * worse. DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS=1 runs them anyway for local development; it is
 * refused when NODE_ENV=production. Remote providers are exempt: their commands run in the
 * session's own VM, terminated with the activity, and never hold a worker-side teardown.
 */
export function assertUnixSocketFilter(session: Pick<SandboxSession, "providerId" | "filtersUnixSockets">, command: Pick<SandboxCommand, "binary" | "denyUnixSockets">): void {
  if (!command.denyUnixSockets || session.filtersUnixSockets) return;
  const optIn = ["1", "true"].includes(process.env.DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS?.trim().toLowerCase() ?? "");
  const production = process.env.NODE_ENV === "production";
  if (optIn && !production) {
    if (!warnedUnfilteredSockets) {
      warnedUnfilteredSockets = true;
      console.warn(
        `[parser-sandbox] status=degraded provider=${session.providerId} reason=unfiltered-unix-sockets ` +
          "detail=DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS runs commands without the UNIX-socket filter; development only",
      );
    }
    return;
  }
  console.error(
    `[parser-sandbox] status=refused provider=${session.providerId} reason=no-unix-socket-filter ` +
      `binary=${path.basename(command.binary)}${optIn ? " detail=opt-in ignored under NODE_ENV=production" : ""}`,
  );
  throw new SandboxPolicyError(
    `parser sandbox provider '${session.providerId}' cannot stop '${path.basename(command.binary)}' from creating UNIX sockets; ` +
      "refusing to run it (use bubblewrap)",
  );
}

/** How long a cancelled command output may take to finish destroying before the call gives up on it. */
const OUTPUT_CANCEL_GRACE_MS = 1_000;

/** After a successful exit, the least time a command's destination gets to finish (a final upload part). */
function outputFinishFloorMs(): number {
  return readPositiveNumber(process.env.WORKER_COMMAND_OUTPUT_FINISH_MS) ?? 60_000;
}

function abortReasonOf(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("The operation was aborted", { cause: signal.reason }), { name: "AbortError" });
}

/** Supervise a launched child with its run and document ids attached to every teardown log line. */
function superviseCommand(plan: CommandPlan, child: ChildProcess, signal?: AbortSignal, unprovable?: string): SupervisedChild {
  return superviseChild(child, {
    label: path.basename(plan.binary),
    signal,
    ...(unprovable ? { unprovable } : {}),
    context: commandAttribution(),
  });
}

/** Who a command runs for, on every teardown log line and quarantine record. */
function commandAttribution(): Record<string, string | undefined> {
  const context = currentPerfContext();
  return {
    org_id: context?.orgId ?? undefined,
    workspace_id: context?.workspaceId,
    run_id: context?.runId,
    document_id: context?.documentId,
    stage: context?.stageName,
  };
}

/**
 * Before any parser command: an activity whose command teardown already failed gets that failure
 * (it ends as a non-retryable teardown), any other activity on a quarantined worker a retryable
 * WorkerQuarantinedError, and a document whose source is quarantined a QuarantinedSourceError.
 */
async function admitCommand(): Promise<void> {
  const latched = latchedTeardownError();
  if (latched) throw latched;
  assertTeardownBreakerClosed();
  await admitCommandSource();
}

export { resolveScriptsDir };

export function planDocumentToolInvocation(
  invocation: DocumentToolInvocation,
): Pick<CommandPlan, "binary" | "args"> {
  const fileArgIndexes = new Set(invocation.fileArgIndexes ?? []);
  const args = invocation.args.map((arg, index) =>
    fileArgIndexes.has(index) ? sanitizeDocumentToolFileArg(arg) : arg,
  );

  if (!invocation.supportsDoubleDash || fileArgIndexes.size === 0) {
    return { binary: invocation.binary, args };
  }

  const firstFileArgIndex = Math.min(...fileArgIndexes);
  if (
    !Number.isFinite(firstFileArgIndex) ||
    firstFileArgIndex < 0 ||
    firstFileArgIndex >= args.length
  ) {
    return { binary: invocation.binary, args };
  }

  if (args.slice(0, firstFileArgIndex + 1).includes("--")) {
    return { binary: invocation.binary, args };
  }

  return {
    binary: invocation.binary,
    args: [
      ...args.slice(0, firstFileArgIndex),
      "--",
      ...args.slice(firstFileArgIndex),
    ],
  };
}

export function sanitizeDocumentToolFileArg(arg: string): string {
  if (
    arg === "-" ||
    !arg.startsWith("-") ||
    path.isAbsolute(arg) ||
    /^[a-z][a-z0-9+.-]*:/i.test(arg)
  ) {
    return arg;
  }

  return `.${path.sep}${arg}`;
}

export function buildCommandEnv(args: {
  plan: CommandPlan;
  venvBin: string;
  isVectorBackend: boolean;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return buildAllowlistedEnv({
    defaultAllowlist: args.isVectorBackend
      ? [...defaultParserEnvAllowlist, ...vectorBackendEnvAllowlist]
      : defaultParserEnvAllowlist,
    allowlistEnvVar: "DOCSLURP_PARSER_ENV_ALLOWLIST",
    overrides: {
      PATH: `${args.venvBin}${path.delimiter}${args.env?.PATH ?? process.env.PATH ?? ""}`,
      ...(args.plan.bundleEnv ?? {}),
      ...(args.plan.pythonPath?.length ? { PYTHONPATH: args.plan.pythonPath.join(path.delimiter) } : {}),
    },
    sourceEnv: args.env,
  });
}

/** Provider-neutral description of a parser command: allowlisted env plus the paths it may read and write. */
export function buildSandboxCommand(args: {
  plan: CommandPlan;
  venvBin: string;
  scriptsDir: string;
  scratchRoot: string;
  configuredWritablePaths: string[];
  limits: SandboxCommand["limits"];
  env?: NodeJS.ProcessEnv;
}): SandboxCommand {
  const paths = resolveCommandPaths({
    plan: args.plan,
    venvBin: args.venvBin,
    scratchRoot: args.scratchRoot,
    configuredWritablePaths: args.configuredWritablePaths,
    scriptsDir: args.scriptsDir,
  });
  return {
    binary: args.plan.binary,
    args: args.plan.args,
    env: buildCommandEnv({ plan: args.plan, venvBin: args.venvBin, isVectorBackend: false, env: args.env }),
    readablePaths: paths.readablePaths,
    inputPaths: paths.inputPaths,
    writablePaths: paths.writablePaths,
    limits: args.limits,
    ...(deniesUnixSockets(args.plan) ? { denyUnixSockets: true } : {}),
  };
}

/** Record a remote provider's cost in the enclosing stage's usage ledger, tagged with its scope. */
function recordRemoteUsage(usage: UsageEvent): void {
  const context = currentPerfContext();
  if (!context) return;
  pushUsageEvent({ ...usage, metadata: { ...usage.metadata, scope: context.scope, stage: context.stageName } });
}

export function isVectorBackendCommand(commandArgs: string[], scriptsDir: string): boolean {
  // Only trusted entrypoints receive backend credentials; input filenames are never capabilities.
  return ["vector_backend_write.py", "orama_write.mjs"].some((script) =>
    commandArgs[0] === path.join(scriptsDir, script));
}

function parseClamSignature(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/:\s+(.+?)\s+FOUND$/m);
  return match?.[1]?.trim() ?? null;
}

export function resolveMalwareScanPolicy(
  env: NodeJS.ProcessEnv = process.env,
): MalwareScanPolicy {
  const production = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  return {
    requireDaemon: readBooleanFlag(
      env.DOCSLURP_CLAMAV_REQUIRE_DAEMON,
      production,
    ),
    failOpenOnStaleDefinitions: readBooleanFlag(
      env.DOCSLURP_CLAMAV_FAIL_OPEN_ON_STALE_DB,
      !production,
    ),
    maxSignatureAgeHours:
      readPositiveNumber(env.DOCSLURP_CLAMAV_MAX_DB_AGE_HOURS) ?? 24,
    databaseDirectory: env.DOCSLURP_CLAMAV_DB_DIR?.trim() || "/var/lib/clamav",
  };
}

export function assessClamDatabaseHealth(args: {
  maxSignatureAgeHours: number;
  entries: Array<{ path: string; updatedAtMs: number }>;
  nowMs?: number;
}): ClamDatabaseHealth {
  if (args.entries.length === 0) {
    return {
      status: "missing",
      updatedAt: null,
      ageHours: null,
      source: null,
    };
  }

  const newest = [...args.entries].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  )[0];

  if (
    !newest ||
    !Number.isFinite(newest.updatedAtMs) ||
    newest.updatedAtMs <= 0
  ) {
    return {
      status: "unknown",
      updatedAt: null,
      ageHours: null,
      source: newest?.path ?? null,
    };
  }

  const nowMs = args.nowMs ?? Date.now();
  const ageHours = roundMetric(
    Math.max(0, nowMs - newest.updatedAtMs) / 3_600_000,
  );
  return {
    status: ageHours > args.maxSignatureAgeHours ? "stale" : "fresh",
    updatedAt: new Date(newest.updatedAtMs).toISOString(),
    ageHours,
    source: newest.path,
  };
}

function inspectClamDatabaseHealth(
  policy: MalwareScanPolicy,
): ClamDatabaseHealth {
  try {
    const entries = readdirSync(policy.databaseDirectory, {
      withFileTypes: true,
    })
      .filter(
        (entry) => entry.isFile() && /\.(?:cld|cvd|inc)$/i.test(entry.name),
      )
      .map((entry) => {
        const resolvedPath = path.join(policy.databaseDirectory, entry.name);
        return {
          path: resolvedPath,
          updatedAtMs: statSync(resolvedPath).mtimeMs,
        };
      });

    return assessClamDatabaseHealth({
      maxSignatureAgeHours: policy.maxSignatureAgeHours,
      entries,
    });
  } catch {
    return {
      status: "missing",
      updatedAt: null,
      ageHours: null,
      source: null,
    };
  }
}

function describeClamDatabaseHealth(
  health: ClamDatabaseHealth,
  maxAgeHours: number,
): string | null {
  if (health.status === "missing") {
    return "clamav signature database is missing";
  }
  if (health.status === "stale") {
    return `clamav signature database is stale (${health.ageHours ?? "unknown"} hours old, max ${maxAgeHours})`;
  }
  return null;
}

/** Run `plan` with an unpacked vendor bundle readable and its site-packages importable. */
export function withVendorBundle(plan: CommandPlan, bundle: InstalledVendorBundle): CommandPlan {
  return {
    ...plan,
    bundleRoots: [...new Set([...(plan.bundleRoots ?? []), bundle.root])],
    pythonPath: [...new Set([...(plan.pythonPath ?? []), bundle.sitePackages])],
    bundleEnv: { ...(plan.bundleEnv ?? {}), ...bundle.env },
  };
}

function isPythonPlan(plan: CommandPlan): boolean {
  return /^python(\d+(\.\d+)?)?$/.test(path.basename(plan.binary)) || plan.args.some((arg) => arg.endsWith(".py"));
}

export function resolveVenvBin(explicitVenv?: string): string {
  if (explicitVenv) {
    return path.join(explicitVenv, "bin");
  }

  const candidates = [
    path.join(process.cwd(), ".venv", "bin"),
    path.join(process.cwd(), "..", ".venv", "bin"),
  ];

  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, "python3")),
    ) ?? candidates[0]
  );
}

export function resolveCommandRssBudgetMb(args: {
  explicitMb?: number | null;
  cgroupLimitMb?: number | null;
}): number | null {
  if (args.explicitMb && args.explicitMb > 0) {
    return args.explicitMb;
  }

  if (!args.cgroupLimitMb || args.cgroupLimitMb <= 0) {
    return null;
  }

  return Math.max(1024, Math.floor(args.cgroupLimitMb * 0.6));
}

export function resolveContainerMemoryLimitMb(args: {
  cgroupLimitRaw?: string | null;
  meminfoRaw?: string | null;
}): number | null {
  const cgroupBytes = parseMemoryLimitBytes(args.cgroupLimitRaw ?? "");
  if (cgroupBytes !== null) {
    return Math.floor(cgroupBytes / (1024 * 1024));
  }

  const memTotalKb = parseMemTotalKb(args.meminfoRaw ?? "");
  if (memTotalKb !== null) {
    return Math.floor(memTotalKb / 1024);
  }

  return null;
}

function detectContainerMemoryLimitMb(): number | null {
  for (const candidate of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const resolved = resolveContainerMemoryLimitMb({
        cgroupLimitRaw: readFileSync(candidate, "utf8"),
      });
      if (resolved !== null) {
        return resolved;
      }
    } catch {}
  }

  try {
    return resolveContainerMemoryLimitMb({
      meminfoRaw: readFileSync("/proc/meminfo", "utf8"),
    });
  } catch {}

  return null;
}

function parseMemoryLimitBytes(raw: string): number | null {
  if (!raw || raw === "max") {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  if (parsed > 9_000_000_000_000_000) {
    return null;
  }

  return parsed;
}

function parseMemTotalKb(raw: string): number | null {
  const match = raw.match(/^MemTotal:\s+(\d+)\s+kB$/m);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function readPositiveNumber(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function formatMemoryMb(rssKb: number): number {
  return roundMetric(rssKb / 1024);
}
