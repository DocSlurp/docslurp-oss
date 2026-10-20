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
import type { Writable } from "node:stream";

import { resolveCommandPaths } from "../sandbox/paths.js";
import { sandboxScopeStorage } from "../sandbox/session-context.js";
import { defaultParserSandbox, registeredParserSandbox } from "../sandbox/startup.js";
import { SandboxRunError, type SandboxCommand, type SandboxResult, type SandboxSession } from "../sandbox/types.js";
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
}

/** A started command: a local child process to monitor, or a remote run that completes on its own. */
export type LaunchedCommand =
  | { child: ChildProcess; release(): Promise<void> }
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
  private readonly warmedCommands = new Set<string>();
  private embedPool?: PythonPool;

  constructor(options: CommandRunnerOptions = {}) {
    this.openSession = options.openSession;
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
          const { child } = launched;
          return await new Promise<CommandResult>((resolve, reject) => {
          const monitor = this.startCommandMonitor(plan, child);

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
              void killProcessTree(child.pid === undefined ? [] : [child.pid]);
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
              void killProcessTree(child.pid === undefined ? [] : [child.pid]);
              return;
            }
            stderr += chunk.toString();
          });
          child.on("error", (error) => {
            reject(monitor.finish() ?? error);
          });
          child.on("close", (code) => {
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
          });
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
          return await this.streamToWritable(plan, launched.child, destination);
        } finally {
          await launched.release();
        }
      },
    );
  }

  private async streamToWritable(
    plan: CommandPlan,
    child: ChildProcess,
    destination: Writable,
  ): Promise<{ stderr: string }> {
    const monitor = this.startCommandMonitor(plan, child);
    let stderr = "";
    let stderrBytes = 0;
    let outputLimitError: Error | null = null;
    const maxOutputBytes =
      readPositiveNumber(process.env.WORKER_COMMAND_MAX_OUTPUT_BYTES) ??
      DEFAULT_MAX_COMMAND_OUTPUT_BYTES;

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        reject(monitor.finish() ?? error);
      });
      child.on("close", (code) => {
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
      });
    });

    child.stderr!.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) {
        outputLimitError = new Error(
          `${plan.binary} stderr exceeded ${maxOutputBytes} bytes`,
        );
        void killProcessTree(child.pid === undefined ? [] : [child.pid]);
        return;
      }
      stderr += chunk.toString();
    });

    await Promise.all([
      pipeline(child.stdout!, destination).catch((error) => {
        throw monitor.peekBudgetError() ?? error;
      }),
      exitPromise,
    ]);

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
  ): Promise<CommandPlan> {
    return await this.planDocumentTool({
      binary: "pdftoppm",
      args: [
        "-png",
        "-r",
        String(dpi),
        "-f",
        String(firstPage),
        "-l",
        String(lastPage),
        source,
        prefix,
      ],
      fileArgIndexes: [7, 8],
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

  async doclingJson(source: string, outdir: string): Promise<CommandPlan> {
    return await this.plan(
      "docling",
      "--from",
      "pdf",
      "--to",
      "json",
      "--output",
      outdir,
      source,
    );
  }

  async doclingVlm(source: string, outdir: string): Promise<CommandPlan> {
    return await this.plan(
      "docling",
      "--from",
      "pdf",
      "--to",
      "md",
      "--pipeline",
      "vlm",
      "--vlm-model",
      "granite_docling",
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
          : await this.collectChild(selected.plan, launched.child, "malware-scan");
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
  private collectChild(plan: CommandPlan, child: ChildProcess, metricPrefix: string): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolve, reject) => {
      const monitor = this.startCommandMonitor(plan, child, { metricPrefix });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        reject(monitor.finish() ?? error);
      });
      child.on("close", (code) => {
        const budgetError = monitor.finish(code);
        if (budgetError) reject(budgetError);
        else resolve({ exitCode: code, stdout, stderr });
      });
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
  async launch(plan: CommandPlan, signal?: AbortSignal): Promise<LaunchedCommand> {
    if (isVectorBackendCommand(plan.args, this.scriptsDir)) {
      const env = buildCommandEnv({ plan, venvBin: this.venvBin, isVectorBackend: true });
      const child = spawn(plan.binary, plan.args, { env, stdio: ["ignore", "pipe", "pipe"], signal });
      return { child, release: async () => {} };
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
      if (session.spawn) return { child: session.spawn(command, signal), release };
      if (session.run) return { remote: session.run(command, signal), timeoutMs: command.limits.timeoutMs, release };
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
          void inspectProcessTree(pid)
            .then((snapshot) => killProcessTree(snapshot?.pids ?? [pid]))
            .catch(() => killProcessTree([pid]));
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
        await killProcessTree(snapshot.pids);
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

async function killProcessTree(pids: number[]): Promise<void> {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
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
