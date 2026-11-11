import { randomBytes, randomUUID } from "node:crypto";
import { pricing } from "@docslurp/shared";

import { boundedVmStream } from "./transfer.js";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkerDeploymentProfile, buildLocalComputeUsageEvent } from "../../../pipeline/local-compute-cost.js";
import type { UsageEvent } from "../../../models.js";
import { readSandboxConfig } from "../../config-schema.js";
import {
  SandboxConfigError,
  SandboxInfrastructureError,
  SandboxOutputError,
  SandboxPolicyError,
  SandboxRunError,
  type ParserSandboxProvider,
  type ScannerSessionSpec,
  type SandboxCommand,
  type SandboxConfigSchema,
  type SandboxIsolation,
  type SandboxResult,
  type SandboxSession,
} from "../../types.js";
import { asParserUser, commandScratchDirs, commandScratchEnv, CONTROL_DIR, HARDEN_LINKS_ARGV, KILL_PARSER_USER_ARGV, killArgv, launchArgv, lockImageArgv, resetArgv } from "./control.js";
import { SessionStaging, type RemoteEntry, type RemoteFs, type RemoteSnapshot } from "./staging.js";
import { vmOnlyParsing } from "../../../lib/vm-only-parsing.js";
import { defaultDocConcurrency, resolveActivityConcurrency } from "../../../concurrency.js";
import { VmBudget } from "./vm-budget.js";
import {
  CLAMD_SELF_TEST_ARGV,
  clamdSelfTestArgv,
  CLAMD_START_ARGV,
  CLAMD_VERSION_ARGV,
  clamdConfig,
  EICAR,
  jobRootsChanged,
  jobRootsListingArgv,
  RESTORED_EGRESS_CHECK_ARGV,
  modalScannerRegions,
  parseClamVersionLine,
  readDefinitionFiles,
  SCANNER_CONFIG_FILE,
  scannerDefinitionsDir,
  scannerSetupArgv,
  ScannerSnapshotCache,
  scannerSnapshotKey,
  SCANNER_CONFIG_DIR,
  SELF_TEST_FILE,
} from "./scanner.js";
import { judgeCanary, policyCanaries } from "../../../tools/clamd-policy.js";

export type ModalSdk = typeof import("modal");

export interface ModalConfig {
  tokenId: string;
  tokenSecret: string;
  app: string;
  /** Image reference sandboxes run; `repo@sha256:<digest>` when a digest is configured. */
  image: string;
  /** Immutable Modal import produced from this image by deployment. */
  imageId?: string;
  /** Name of a Modal Secret with REGISTRY_USERNAME/REGISTRY_PASSWORD for a private image. */
  registrySecret?: string;
  cpu: number;
  memoryMb: number;
  sessionTimeoutSeconds: number;
  /** Parser VMs one activity may run at once (modalVmsPerActivity); each runs one command at a time. */
  vmsPerActivity?: number;
  /** Parser VMs one worker process may run at once across its activities (modalVmsPerWorker). */
  vmsPerWorker?: number;
  /** An idle pool VM is terminated after this long (modalVmIdleSeconds). */
  vmIdleSeconds?: number;
  /** Tests only: how long a terminate waits for a create call in flight (CREATE_SETTLE_MS). */
  createSettleMs?: number;
  /** Tests only: the deadline on one read-only asset write (ASSET_WRITE_DEADLINE_MS). */
  assetWriteDeadlineMs?: number;
  /** Tests only: when an unconfirmed creation's token is released at the latest (default: lifetime plus margins). */
  unconfirmedBackstopMs?: number;
  /** Regions scanner snapshot VMs run in (modalScannerRegions). */
  scannerRegions?: string[];
}

/**
 * `processes` here means nothing a command starts runs on the worker host, not that remote
 * descendants die with the command: one that starts its own session can keep running inside this
 * activity's Modal sandbox (and writing its remote directories) until the session closes or
 * `sessionTimeoutSeconds` ends it. See docs/self-host/sandbox-providers.md, "Process teardown".
 */
/**
 * The parser VM's main process: idle until terminated. Never the image's own entrypoint, which is the worker's start script
 * (`start-worker.sh`, with a first-boot network install) and would run beside the customer job (real-Modal validation N1).
 */
export const PARSER_VM_IDLE_COMMAND = ["sleep", "infinity"] as const;
/** Creates a directory under $1 and removes it, as the parser user (the launch drops root): exit 0 when $1 is a usable job root. */
const JOB_ROOT_WRITABLE_SCRIPT = 'mkdir -p -- "$1" && d=$(mktemp -d "$1/.docslurp-probe.XXXXXX") && rmdir -- "$d"';

/** The roots parser job paths sit under: the worker's temp directory and the parser scratch root (tools/runner.ts). */
export function parserJobRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [os.tmpdir(), env.DOCSLURP_PARSER_SANDBOX_ROOT?.trim() || "/tmp/docslurp-parser-sandbox"];
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/**
 * Parser VMs one activity may run at once (recheck R #5): one per concurrent unit of parser work, so the documents an
 * activity processes at once (WORKER_DOC_CONCURRENCY) and, unless WORKER_SERIALIZE_PDF_CANDIDATES is on, their two PDF
 * candidates each get a VM. DOCSLURP_MODAL_VMS_PER_ACTIVITY overrides it (1 to 16). VMs open only when every open one is
 * busy, so a one-document activity still starts one.
 */
export function modalVmsPerActivity(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number.parseInt(env.DOCSLURP_MODAL_VMS_PER_ACTIVITY ?? "", 10);
  if (Number.isSafeInteger(explicit) && explicit >= 1) return Math.min(explicit, 16);
  const configured = Number.parseInt(env.WORKER_DOC_CONCURRENCY ?? "", 10);
  const documents = Number.isSafeInteger(configured) && configured >= 1 ? configured : defaultDocConcurrency();
  const serialized = ["1", "true", "yes", "on"].includes((env.WORKER_SERIALIZE_PDF_CANDIDATES ?? "").trim().toLowerCase());
  return Math.min(16, documents * (serialized ? 1 : 2));
}

/**
 * Parser VMs one worker process may run at once, across all its activities (VM pool follow-up): the fleet's worst case
 * is workers x this. Defaults to the worker's activity slots (WORKER_ACTIVITY_CONCURRENCY), so a fleet never runs more
 * parser VMs than it did with one VM per activity; an activity's extra VMs use slots other activities leave free.
 * DOCSLURP_MODAL_VMS_PER_WORKER overrides it (1 to 64).
 */
export function modalVmsPerWorker(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number.parseInt(env.DOCSLURP_MODAL_VMS_PER_WORKER ?? "", 10);
  if (Number.isSafeInteger(explicit) && explicit >= 1) return Math.min(explicit, 64);
  return Math.min(64, resolveActivityConcurrency(env));
}

/**
 * Seconds an idle pool VM lives before it is terminated (DOCSLURP_MODAL_VM_IDLE_SECONDS, 1 to 300, default 20). A new
 * VM costs about 2 s to start and harden, so a gap shorter than that is cheaper to wait through; 20 s covers the gaps
 * between a document's commands inside a stage (staging, model calls between candidates) while bounding the idle time
 * Modal bills per VM to 20 s after its last command. Every VM is terminated when the stage settles or the activity ends.
 */
export function modalVmIdleSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DOCSLURP_MODAL_VM_IDLE_SECONDS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 300 ? raw : 20;
}

/** Lifetime of the startup probe's VM: a backstop if its terminate request is lost. */
export const PROBE_SESSION_TIMEOUT_SECONDS = 120;
/** Deadline for the terminate request. Modal stops the VM once it accepts the request; exit is not awaited. */
const TERMINATE_REQUEST_MS = 10_000;
/** Root-owned home of read-only assets in a parser VM (ClamAV definitions), outside every job tree. */
const ASSET_ROOT = "/opt/docslurp-assets";
/** How long a terminate waits for a create call still in flight before leaving it to settle on its own. */
const CREATE_SETTLE_MS = 5_000;
/** The deadline on Modal's create call (ensureSandbox). */
const CREATE_DEADLINE_MS = 30_000;
/** Added to a quarantined VM's lifetime bound (at most 10% of the lifetime): Modal's stop is not instantaneous. */
const LIFETIME_MARGIN_MS = 60_000;

const ISOLATION: SandboxIsolation = { filesystem: true, network: "full", processes: true, location: "remote" };

const configSchema: SandboxConfigSchema = {
  type: "object",
  required: ["tokenId", "tokenSecret"],
  properties: {
    tokenId: { type: "string", description: "Modal API token id.", secret: true, env: "MODAL_TOKEN_ID" },
    tokenSecret: { type: "string", description: "Modal API token secret.", secret: true, env: "MODAL_TOKEN_SECRET" },
    app: {
      type: "string",
      description: "Modal app that owns the parser sandboxes.",
      default: "docslurp-parsers",
      env: "DOCSLURP_MODAL_APP",
    },
    image: {
      type: "string",
      description:
        "Container image sandboxes run, which must contain the parser binaries. Defaults to " +
        "ghcr.io/docslurp/worker-full:<DOCSLURP_VERSION> in release images; required otherwise. " +
        "Accepts a digest-pinned reference (repo@sha256:<digest>).",
      env: "DOCSLURP_MODAL_IMAGE",
    },
    imageId: { type: "string", description: "Immutable Modal image import ID, supplied together with the pinned registry image by deployment.", env: "DOCSLURP_MODAL_IMAGE_ID" },
    imageDigest: {
      type: "string",
      description:
        "Optional sha256:<digest> that pins the image (the default or DOCSLURP_MODAL_IMAGE) by digest " +
        "instead of its mutable tag. Copy it from the worker-images.yml run summary after verifying " +
        "the signature with cosign.",
      env: "DOCSLURP_MODAL_IMAGE_DIGEST",
    },
    registrySecret: {
      type: "string",
      description:
        "Name of a Modal Secret holding REGISTRY_USERNAME and REGISTRY_PASSWORD, for pulling a private image.",
      env: "DOCSLURP_MODAL_REGISTRY_SECRET",
    },
    cpu: { type: "number", description: "Requested CPU cores per sandbox.", default: 2, env: "DOCSLURP_MODAL_CPU" },
    memoryMb: {
      type: "number",
      description: "Requested memory in MiB per sandbox.",
      default: 4096,
      env: "DOCSLURP_MODAL_MEMORY_MB",
    },
    sessionTimeoutSeconds: {
      type: "number",
      description: "Maximum lifetime of a sandbox; bounds billing if a session leaks.",
      default: 900,
      env: "DOCSLURP_MODAL_SESSION_TIMEOUT_SECONDS",
    },
  },
};

/**
 * Release worker images bake DOCSLURP_VERSION (worker-images.yml), and the same release
 * publishes worker-full under that tag. Source and development installs have no published
 * image of their own version, so they must name one.
 */
function defaultModalImage(env: NodeJS.ProcessEnv): string {
  const version = env.DOCSLURP_VERSION?.trim();
  if (version) return `ghcr.io/docslurp/worker-full:${version}`;
  throw new SandboxConfigError(
    "Invalid sandbox configuration; missing required: DOCSLURP_MODAL_IMAGE (DOCSLURP_VERSION is unset, " +
      "so there is no published worker image to default to; release images set it)",
  );
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Oldest qpdf the parser VM may carry (worker/Dockerfile.lean pins the exact Debian package). */
export const MIN_PARSER_VM_QPDF = "11.0.0";

/** Whether a contract's `qpdfVersion` is a qpdf release at or above MIN_PARSER_VM_QPDF. */
export function supportedQpdfVersion(version: unknown): boolean {
  if (typeof version !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) return false;
  const have = version.split(".").map(Number);
  const need = MIN_PARSER_VM_QPDF.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (have[index] !== need[index]) return have[index]! > need[index]!;
  return true;
}

/**
 * The image reference sandboxes pull. A configured digest replaces the tag
 * (`repo:tag` becomes `repo@sha256:...`), so a re-pushed tag cannot change what
 * runs; a digest already in the reference must be a well-formed sha256 and agree
 * with DOCSLURP_MODAL_IMAGE_DIGEST when both are set.
 */
export function resolveModalImage(image: string, digest?: string): string {
  const at = image.indexOf("@");
  const pinned = at >= 0 ? image.slice(at + 1) : undefined;
  if (pinned !== undefined && !DIGEST.test(pinned)) {
    throw new SandboxConfigError("Invalid sandbox configuration; invalid: DOCSLURP_MODAL_IMAGE (digest must be sha256:<64 hex>)");
  }
  if (digest === undefined) return image;
  if (!DIGEST.test(digest)) {
    throw new SandboxConfigError("Invalid sandbox configuration; invalid: DOCSLURP_MODAL_IMAGE_DIGEST (expected sha256:<64 hex>)");
  }
  if (pinned !== undefined && pinned !== digest) {
    throw new SandboxConfigError(
      "Invalid sandbox configuration; invalid: DOCSLURP_MODAL_IMAGE_DIGEST (does not match the digest in DOCSLURP_MODAL_IMAGE)",
    );
  }
  const name = at >= 0 ? image.slice(0, at) : image;
  // Drop a tag (a ':' after the last '/'; a registry port comes before it).
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const repository = colon > slash ? name.slice(0, colon) : name;
  return `${repository}@${digest}`;
}

/** Error text with secret config values removed. Never forward raw SDK errors. */
function safeMessage(config: Partial<ModalConfig>, error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of ["tokenSecret", "tokenId"] as const) {
    const value = config[key];
    if (typeof value === "string" && value.length > 0) message = message.split(value).join("[redacted]");
  }
  return message;
}

/** The SDK reports an exec deadline as a typed timeout error or a plain "Deadline exceeded ..." error. */
/** How long the post-command wipe and health check may take (RESET_SCRIPT). */
const RESET_DEADLINE_MS = 60_000;

function isControlDeadline(error: unknown): boolean {
  return error instanceof Error && error.message === "parser VM control deadline exceeded";
}

function isExecTimeout(sdk: ModalSdk, error: unknown): boolean {
  for (const type of [sdk.TimeoutError, sdk.SandboxTimeoutError]) {
    if (typeof type === "function" && error instanceof type) return true;
  }
  return error instanceof Error && error.message.startsWith("Deadline exceeded");
}

/** Modal rejects an exec timeout that is not a whole number of seconds; round up so the command gets at least its limit. */
function execTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000)) * 1000;
}

/** How long an abort waits for the kill exec, and then for the killed command's exec to end. */
const KILL_SETTLE_MS = 10_000;

/** How a remote command ended: it exited on its own, hit its time limit, or was aborted by the caller. */
type RemoteOutcome =
  | { kind: "exited"; output: { stdout: string; stderr: string; exitCode: number | null } }
  | { kind: "timeout" }
  | { kind: "aborted" };

class CommandAborted extends Error {}
/** A command waiting for a worker VM token gives up its empty lane for an idle VM of its own activity (real-Modal P2). */
class HandOver extends Error {}

/**
 * Read-only asset staging holds whole files in memory (the SDK writes from a buffer): one VM stages at a time per worker
 * process, so the peak is one definitions file, not one per VM starting at once (council W #7).
 */
let assetStagingTail: Promise<unknown> = Promise.resolve();
function withAssetStagingSlot<T>(work: () => Promise<T>): Promise<T> {
  const run = assetStagingTail.then(work, work);
  assetStagingTail = run.catch(() => {});
  return run;
}

/**
 * As the parser user: every job root is either absent and creatable, or a real directory (not a link) owned by root or the
 * parser user that takes a new directory. Exit 0 when usable.
 */
const JOB_TREE_PROBE_SCRIPT = [
  'for r in "$@"; do',
  '  if [ -L "$r" ]; then exit 3; fi',
  '  if [ -e "$r" ]; then [ -d "$r" ] || exit 3; o=$(stat -c %u -- "$r") || exit 3; [ "$o" = 0 ] || [ "$o" = "$(id -u)" ] || exit 3; fi',
  '  mkdir -p -- "$r" && d=$(mktemp -d "$r/.docslurp-probe.XXXXXX") && rmdir -- "$d" || exit 3',
  "done",
].join("\n");

/** How long one read-only asset file may take to reach a VM. */
const ASSET_WRITE_DEADLINE_MS = 3 * 60_000;

/** How long the worker's read-only assets (the ClamAV definitions) may take to reach a VM, apart from any command. */
const ASSET_STAGING_DEADLINE_MS = 10 * 60_000;

/** A staging failure the VM reports for the document's own data (no space, quota), not a Modal API or transport error. */
function isOwnStagingFailure(error: unknown): boolean {
  // Modal's filesystem API reports a full disk on writeBytes as a bare "I/O error" (real-Modal W2a).
  return /\bENOSPC\b|no space left|\bEDQUOT\b|disk quota exceeded|file too large|\bEFBIG\b|^I\/O error$/i.test(error instanceof Error ? error.message : String(error));
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("parser VM control deadline exceeded")), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CommandAborted();
}

/** Resolves when `signal` aborts (at once if it already has); `dispose` drops the listener. */
function whenAborted(signal: AbortSignal | undefined): { promise: Promise<"aborted">; dispose(): void } {
  if (!signal) return { promise: new Promise(() => {}), dispose: () => {} };
  let onAbort!: () => void;
  const promise = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

function assertCredentials(config: ModalConfig): void {
  for (const [key, env] of [
    ["tokenId", "MODAL_TOKEN_ID"],
    ["tokenSecret", "MODAL_TOKEN_SECRET"],
  ] as const) {
    const value: unknown = config[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new SandboxConfigError(`${env} must be a non-empty string`);
    }
  }
}

function toRemoteEntry(info: import("modal").FileInfo): RemoteEntry {
  return { path: info.path, isDir: info.type === "directory", size: info.size, mtime: info.modifiedTime };
}

/** Run a short control command in the VM and require exit 0 (bounded output, never shown to customers). */
async function runChecked(sandbox: import("modal").Sandbox, argv: string[], failure: string): Promise<void> {
  const proc = await sandbox.exec(argv, { mode: "binary", timeoutMs: 30_000 });
  const [, , code] = await Promise.all([boundedVmStream(proc.stdout, 64 * 1024), boundedVmStream(proc.stderr, 64 * 1024), proc.wait()]);
  if (code !== 0) throw new Error(failure);
}

/**
 * A staging step in a job tree, as the parser user (recheck S #2): a non-zero exit or output over its bound means the tree
 * is not what staging expects (a job replaced a directory, planted a link, filled the disk), so it is a SandboxOutputError;
 * an exec that cannot run at all is the sandbox's and propagates as is.
 */
async function runInJobTree(sandbox: import("modal").Sandbox, argv: string[], failure: string): Promise<void> {
  const proc = await sandbox.exec(argv, { mode: "binary", timeoutMs: 30_000 });
  const [, , code] = await Promise.all([
    boundedVmStream(proc.stdout, 64 * 1024).catch(() => null),
    boundedVmStream(proc.stderr, 64 * 1024).catch(() => null),
    proc.wait(),
  ]);
  if (code !== 0) throw new SandboxOutputError(failure);
}

/** Read a bounded stream of job output; going over the bound is the job's (recheck S #2a). */
async function boundedJobOutput(stream: ReadableStream<Uint8Array | string>, limit: number, what: string): Promise<Buffer> {
  try {
    return await boundedVmStream(stream, limit);
  } catch (error) {
    if (error instanceof Error && error.message === "parser VM transfer exceeded byte limit") throw new SandboxOutputError(`${what} exceeds its limit`);
    throw error;
  }
}

function buildRemoteFs(sdk: ModalSdk, sandbox: import("modal").Sandbox): RemoteFs {
  const fs = sandbox.filesystem;
  return {
    async stat(p) {
      try {
        const info = await fs.stat(p);
        return info.type === "symlink" ? null : toRemoteEntry(info);
      } catch (error) {
        if (error instanceof sdk.SandboxFilesystemNotFoundError) return null;
        throw error;
      }
    },
    // Job-controlled trees are written only as the parser user (council M #3): root writes the bytes into its own control
    // directory, then uid 10001 copies them into place, so a link a surviving job process planted reaches only what
    // uid 10001 could already write.
    async writeFile(p, data) {
      const staged = `${CONTROL_DIR}/upload-${randomUUID()}`;
      await fs.writeBytes(data, staged);
      try {
        await runChecked(sandbox, ["/bin/chmod", "0644", "--", staged], "parser VM upload staging failed");
        await runInJobTree(sandbox, [...asParserUser(), "/bin/sh", "-c", 'mkdir -p -- "$(dirname -- "$2")" && cp -- "$1" "$2"', "sh", staged, p], "parser VM upload into the job tree failed");
      } finally {
        await fs.remove(staged).catch(() => {});
      }
    },
    async readFile(p) {
      // Read as the parser user: root never follows a link the job left in its own output (council K #5).
      const proc = await sandbox.exec([...asParserUser(), "/bin/cat", "--", p], { mode: "binary", timeoutMs: 30_000 });
      const [data, , code] = await Promise.all([boundedJobOutput(proc.stdout, 128 * 1024 * 1024, "parser VM output file"), boundedVmStream(proc.stderr, 64 * 1024).catch(() => null), proc.wait()]);
      // Run as the parser user: a non-zero exit is the job's own output (made unreadable, a fifo), the document's fault.
      if (code !== 0) throw new SandboxOutputError("parser VM output could not be read back");
      return data;
    },
    async list(p) {
      // Do not ask the SDK to allocate an unbounded directory listing from the guest.
      const code = "import os,sys,json\np=sys.argv[1]\nwith os.scandir(p) as entries:\n for i,e in enumerate(entries):\n  if i>=8192: raise RuntimeError('directory entry limit')\n  if e.is_symlink(): continue\n  st=e.stat(follow_symlinks=False)\n  print(json.dumps(dict(path=e.path,isDir=e.is_dir(follow_symlinks=False),size=st.st_size,mtime=st.st_mtime)))";
      const proc = await sandbox.exec([...asParserUser(), "python3", "-I", "-c", code, p], { mode: "binary", timeoutMs: 30_000 });
      const [data, , status] = await Promise.all([boundedJobOutput(proc.stdout, 4 * 1024 * 1024, "parser VM output directory listing"), boundedVmStream(proc.stderr, 64 * 1024).catch(() => null), proc.wait()]);
      if (status !== 0) throw new SandboxOutputError("parser VM output directory could not be listed (unreadable, or over the entry limit)");
      return data.toString("utf8").split("\n").filter(Boolean).map((line) => {
        const entry = JSON.parse(line) as RemoteEntry;
        if (typeof entry.path !== "string" || path.dirname(entry.path) !== p || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.isDir !== "boolean" || !Number.isFinite(entry.mtime)) throw new SandboxOutputError("invalid parser VM directory entry");
        return entry;
      });
    },
    mkdir: (p) => runInJobTree(sandbox, [...asParserUser(), "/bin/mkdir", "-p", "--", p], "parser VM directory creation in the job tree failed"),
    mkdirAll: (paths) => runInJobTree(sandbox, [...asParserUser(), "/bin/mkdir", "-p", "--", ...paths], "parser VM directory creation in the job tree failed"),
    remove: (p) => runInJobTree(sandbox, [...asParserUser(), "/bin/rm", "-rf", "--", p], "parser VM removal in the job tree failed"),
  };
}

/**
 * Provider cost of one command as a usage event. The SDK reports no cpu/memory consumption
 * for a sandbox, so usage is the requested cpu x wall seconds and requested memory GiB x wall
 * seconds (what Modal bills for, at max(request, usage)). It is priced at the pricing provider's sandbox
 * rates (`internalCost.sandboxCostCents`; 0 under the open default), not the worker host's, and the
 * cost rides as `providerCostCents` so the provider-cost loss alert sees it. It is provider cost only:
 * `costRollup: "included"` and `billable: false` keep it out of customer credits.
 *
 * `amount` is NOT provider cost: it is the local-compute rate-card estimate for the same CPU and memory seconds
 * (buildLocalComputeUsageEvent), several times lower than Modal's price. Provider cost is `metadata.providerCostCents`
 * only; the loss alert and spend attribution read that, and `amount` is summed only for billable page and minute metrics.
 */
export function buildModalUsageEvent(config: ModalConfig, activityId: string, wallSeconds: number): UsageEvent {
  const cpuSeconds = config.cpu * wallSeconds;
  const memoryGbSeconds = (config.memoryMb / 1024) * wallSeconds;
  const base = resolveWorkerDeploymentProfile();
  const event = buildLocalComputeUsageEvent({
    metric: "sandbox_compute",
    observation: { cpuSeconds, memoryGbSeconds, wallTimeMs: wallSeconds * 1000 },
    profile: {
      ...base,
      id: `modal:${config.app}`,
      workerClass: "modal-sandbox",
      region: "modal",
      image: config.image,
      allocatedVcpu: config.cpu,
      allocatedMemoryGb: config.memoryMb / 1024,
    },
    costRollup: "included",
    metadata: { activityId, sandboxProvider: "modal", billable: false },
  });
  const memoryGib = config.memoryMb / 1024;
  const providerCostCents = pricing().internalCost.sandboxCostCents({ provider: "modal", cores: config.cpu, memoryGib, seconds: wallSeconds });
  return {
    ...event,
    provider: "modal",
    metadata: {
      ...event.metadata,
      providerCostCents,
      effectiveCostCents: providerCostCents,
      infraCostCents: providerCostCents,
      costSource: "estimate",
      rateSource: "modal-sandbox",
      rateObservedAt: pricing().internalCost.sandboxRatesObservedAt("modal"),
      physicalCores: config.cpu,
      memoryGib,
      wallSeconds,
    },
  };
}

/** Deadlines for one scanner snapshot build: the signature upload and clamd's load take tens of seconds at most. */
const SCANNER_BUILD_STEP_MS = 5 * 60_000;
const SCANNER_SNAPSHOT_TAKE_MS = 3 * 60_000;

async function rootExec(vm: import("modal").Sandbox, argv: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = await withDeadline(vm.exec(argv, { timeoutMs, mode: "text" }), timeoutMs + 5_000);
  const [stdout, stderr, code] = await withDeadline(Promise.all([
    boundedJobOutput(proc.stdout, 4 * 1024 * 1024, "scanner build stdout").then((bytes) => bytes.toString("utf8")),
    boundedJobOutput(proc.stderr, 1024 * 1024, "scanner build stderr").then((bytes) => bytes.toString("utf8")),
    proc.wait(),
  ]), timeoutMs + 5_000);
  return { code, stdout, stderr };
}

async function rootExecChecked(vm: import("modal").Sandbox, argv: string[], failure: string, timeoutMs = 60_000): Promise<string> {
  const result = await rootExec(vm, argv, timeoutMs);
  // The build VM holds only the image, the worker's signatures and our config: its output is ours, never a document's.
  if (result.code !== 0) throw new Error(`${failure} (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-300)}`);
  return result.stdout;
}

/**
 * Build one scanner snapshot (scanner.ts): a fresh, hardened and locked VM loads the worker's own signature files into
 * clamd, proves the daemon reports the expected signature version and detects EICAR, proves its job roots hold nothing
 * the image did not ship, and is snapshotted. No job command or job input ever reaches this VM; it is terminated after
 * the snapshot (or any failure). Throws on any failed check: no snapshot means no scan (fail closed).
 */
export async function buildScannerSnapshot(
  sdk: ModalSdk,
  client: InstanceType<ModalSdk["ModalClient"]>,
  config: ModalConfig,
  spec: ScannerSessionSpec,
  onUsage: (event: UsageEvent | undefined) => void,
): Promise<import("modal").SandboxSnapshot> {
  const files = await readDefinitionFiles(spec.definitionsDir);
  const app = await withDeadline(client.apps.fromName(config.app, { createIfMissing: true }), 30_000);
  const registrySecret = config.registrySecret && !config.imageId ? await withDeadline(client.secrets.fromName(config.registrySecret), 30_000) : undefined;
  const image = config.imageId ? await withDeadline(client.images.fromId(config.imageId), 30_000) : client.images.fromRegistry(config.image, registrySecret);
  const name = `docslurp-scanner-build-${randomBytes(12).toString("hex")}`;
  const started = Date.now();
  let vm: import("modal").Sandbox | undefined;
  let createdAt: number | undefined;
  const steps: string[] = [];
  const mark = (step: string) => steps.push(`${step}=${Date.now() - started}`);
  // Kept so a create that resolves after its deadline (or after the build gave up) is still stopped and metered.
  let abandoned = false;
  let createRequest: Promise<import("modal").Sandbox> | undefined;
  try {
    createRequest = client.sandboxes.create(app, image, {
      name,
      runtime: "vm",
      command: [...PARSER_VM_IDLE_COMMAND],
      includeOidcIdentityToken: false,
      env: {}, secrets: [], volumes: {}, cloudBucketMounts: {},
      cpu: config.cpu, cpuLimit: config.cpu,
      memoryMiB: config.memoryMb, memoryLimitMiB: config.memoryMb,
      // Restored VMs keep this lifetime bound (measured on Modal: it runs from the restore), like every parser VM.
      timeoutMs: config.sessionTimeoutSeconds * 1000,
      blockNetwork: true,
      regions: config.scannerRegions ?? ["us"],
      experimentalEnableSnapshot: true,
    });
    createRequest.then((late) => {
      if (abandoned) void stopLateBuildVm(sdk, config, late, onUsage);
    }, () => {});
    vm = await withDeadline(createRequest, CREATE_DEADLINE_MS);
    createdAt = Date.now();
    mark("created");
    const jobRoots = parserJobRoots();
    if ((await rootExec(vm, HARDEN_LINKS_ARGV, 10_000)).code !== 0) throw new Error("scanner VM kernel link protections could not be turned on");
    await rootExecChecked(vm, lockImageArgv(jobRoots), "scanner VM image paths are writable by the parser user", 120_000);
    await withDeadline(vm.filesystem.makeDirectory(CONTROL_DIR), 30_000);
    await rootExecChecked(vm, ["/bin/chmod", "0711", "--", CONTROL_DIR], "scanner VM control directory setup failed");
    // The job roots of a fresh, locked parser VM: the snapshot's must be exactly these (scanner.ts jobRootsChanged).
    const before = await rootExecChecked(vm, jobRootsListingArgv(jobRoots), "scanner VM job roots could not be listed");
    mark("hardened");
    // The worker's own signature files, root-owned and read-only, outside every job tree.
    const vmDir = scannerDefinitionsDir(ASSET_ROOT, spec.signatureSetHash);
    await withDeadline(vm.filesystem.makeDirectory(vmDir), 30_000);
    for (const file of files) await withDeadline(vm.filesystem.writeBytes(file.data, `${vmDir}/${file.name}`), config.assetWriteDeadlineMs ?? ASSET_WRITE_DEADLINE_MS);
    await rootExecChecked(vm, ["/bin/chmod", "0755", "--", ASSET_ROOT, vmDir], "scanner VM asset directory setup failed");
    await rootExecChecked(vm, ["/bin/chmod", "0444", "--", ...files.map((file) => `${vmDir}/${file.name}`)], "scanner VM asset setup failed");
    mark("signatures-staged");
    await rootExecChecked(vm, scannerSetupArgv(), "scanner VM daemon directories could not be created");
    await withDeadline(vm.filesystem.writeBytes(new TextEncoder().encode(clamdConfig(vmDir)), SCANNER_CONFIG_FILE), 30_000);
    await rootExecChecked(vm, ["/bin/chmod", "0444", "--", SCANNER_CONFIG_FILE], "scanner VM daemon config setup failed");
    // clamd loads every signature, then daemonizes as its unprivileged user: the expensive step, done once per set.
    await rootExecChecked(vm, CLAMD_START_ARGV, "scanner VM malware daemon did not start", SCANNER_BUILD_STEP_MS);
    mark("daemon-loaded");
    const reported = parseClamVersionLine((await rootExecChecked(vm, CLAMD_VERSION_ARGV, "scanner VM malware daemon did not answer")).split("\n")[0] ?? "");
    if (!reported || reported.version !== spec.expectedVersion) {
      throw new Error(`scanner VM malware daemon loaded signature version ${reported?.version ?? "unknown"}, expected ${spec.expectedVersion}`);
    }
    await withDeadline(vm.filesystem.writeBytes(new TextEncoder().encode(EICAR), SELF_TEST_FILE), 30_000);
    const selfTest = await rootExec(vm, CLAMD_SELF_TEST_ARGV);
    if (selfTest.code !== 1 || !/Eicar.*FOUND/i.test(selfTest.stdout)) throw new Error(`scanner VM malware daemon failed its EICAR self-test (exit ${selfTest.code})`);
    await rootExecChecked(vm, ["/bin/rm", "-f", "--", SELF_TEST_FILE], "scanner VM self-test file could not be removed");
    // The loaded daemon's effective policy (clamd-policy.ts): encrypted content and limit hits must be detections.
    for (const canary of policyCanaries()) {
      const file = `${SCANNER_CONFIG_DIR}/${canary.name}`;
      await withDeadline(vm.filesystem.writeBytes(canary.data, file), 30_000);
      const result = await rootExec(vm, clamdSelfTestArgv(file));
      const refusal = judgeCanary(canary.kind, { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }, file);
      if (refusal) throw new Error(`scanner VM malware daemon failed its policy self-test: ${refusal}`);
      await rootExecChecked(vm, ["/bin/rm", "-f", "--", file], "scanner VM self-test file could not be removed");
    }
    // Nothing reached a job tree: the snapshot holds the image, the signatures, the config and the loaded daemon only.
    const after = await rootExecChecked(vm, jobRootsListingArgv(jobRoots), "scanner VM job roots could not be listed");
    const changed = jobRootsChanged(before, after);
    if (changed.length) throw new Error(`scanner VM job roots changed before the snapshot (${changed.length} entries); refusing to snapshot`);
    mark("verified");
    const snapshot = await withDeadline(vm.experimentalSnapshot(), SCANNER_SNAPSHOT_TAKE_MS);
    mark("snapshot");
    console.log(`[parser-sandbox] provider=modal status=scanner-snapshot-built signature_version=${spec.expectedVersion} signature_set=${spec.signatureSetHash.slice(0, 16)} ${steps.join(" ")}`);
    return snapshot;
  } catch (error) {
    console.error(`[parser-sandbox] provider=modal status=scanner-snapshot-failed signature_set=${spec.signatureSetHash.slice(0, 16)} ${steps.join(" ")}: ${safeMessage(config, error)}`);
    if (!vm) {
      // The create may still resolve (a deadline, not a refusal): its VM is stopped and metered when it does.
      abandoned = true;
      // A transport failure can hide a VM Modal made: find it by name and stop it (council W #6), best effort.
      await withDeadline(client.sandboxes.fromName(config.app, name), 10_000).then((orphan) => withDeadline(orphan.terminate(), TERMINATE_REQUEST_MS)).catch(() => {});
    }
    throw new SandboxInfrastructureError(`modal scanner snapshot build failed: ${safeMessage(config, error)}`, undefined, { cause: error });
  } finally {
    if (vm) {
      await terminateBuildVm(sdk, config, vm);
      if (createdAt !== undefined) meterBuildVm(config, onUsage, (Date.now() - createdAt) / 1000);
    }
  }
}

/** Stop a build VM: on the build's client, then once more on a fresh one (the session that owned the client may be gone). */
async function terminateBuildVm(sdk: ModalSdk, config: ModalConfig, vm: import("modal").Sandbox): Promise<boolean> {
  try { await withDeadline(vm.terminate(), TERMINATE_REQUEST_MS); return true; } catch { /* retried below */ }
  let fresh: InstanceType<ModalSdk["ModalClient"]> | undefined;
  try {
    fresh = new sdk.ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret });
    await withDeadline(new sdk.Sandbox(fresh, vm.sandboxId).terminate(), TERMINATE_REQUEST_MS);
    return true;
  } catch (error) {
    console.error(`[parser-sandbox] provider=modal status=scanner-build-terminate-unconfirmed: ${safeMessage(config, error)}; its lifetime bound still applies`);
    return false;
  } finally {
    fresh?.close();
  }
}

function meterBuildVm(config: ModalConfig, onUsage: (event: UsageEvent | undefined) => void, wallSeconds: number): void {
  try { onUsage(buildModalUsageEvent(config, "scanner-snapshot-build", wallSeconds)); }
  catch (error) { console.error(`[sandbox-usage] provider=modal status=unrecorded reason=meter-failed kind=scanner-build: ${safeMessage(config, error)}`); }
}

/**
 * A build VM whose create resolved after the build stopped waiting for it (deadline, or a failed name lookup): it never
 * ran anything, but it is a billed VM. Stop it and meter it from its arrival (correctness council Medium).
 */
async function stopLateBuildVm(sdk: ModalSdk, config: ModalConfig, late: import("modal").Sandbox, onUsage: (event: UsageEvent | undefined) => void): Promise<void> {
  const arrived = Date.now();
  console.error(`[parser-sandbox] provider=modal status=scanner-build-late-vm: stopping a build VM that arrived after its deadline`);
  await terminateBuildVm(sdk, config, late);
  meterBuildVm(config, onUsage, (Date.now() - arrived) / 1000);
}

export function createModalProvider(loadSdk: () => Promise<ModalSdk>): ParserSandboxProvider<ModalConfig> {
  async function loadClient(config: ModalConfig) {
    assertCredentials(config);
    let sdk: ModalSdk;
    try {
      sdk = await loadSdk();
    } catch {
      throw new Error("modal package not installed");
    }
    try {
      return { sdk, client: new sdk.ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret }) };
    } catch (error) {
      throw new Error(`modal client rejected configuration: ${safeMessage(config, error)}`);
    }
  }

  /** One budget per worker process (one provider instance), sized by the first session's config. */
  let budget: VmBudget | undefined;
  /** Scanner snapshots of this worker process, by image, size, region and signature set (scanner.ts). */
  const scannerSnapshots = new ScannerSnapshotCache<import("modal").SandboxSnapshot>();

  const provider: ParserSandboxProvider<ModalConfig> = {
    id: "modal",
    name: "Modal",
    description: "Runs each parser in a remote Modal sandbox with files staged in and out per activity.",
    configSchema,
    readConfig: (env) => {
      const { imageDigest, ...config } = readSandboxConfig<
        Omit<ModalConfig, "image"> & { image?: string; imageDigest?: string }
      >(configSchema, env);
      const image = resolveModalImage(config.image ?? defaultModalImage(env), imageDigest);
      if (vmOnlyParsing(env) && !/@sha256:[a-f0-9]{64}$/i.test(image)) {
        throw new SandboxConfigError("production parser VM images must be pinned by sha256 digest");
      }
      if (config.imageId && !/^im-[A-Za-z0-9]+$/.test(config.imageId)) throw new SandboxConfigError("invalid DOCSLURP_MODAL_IMAGE_ID");
      return { ...config, image, vmsPerActivity: modalVmsPerActivity(env), vmsPerWorker: modalVmsPerWorker(env), vmIdleSeconds: modalVmIdleSeconds(env), scannerRegions: modalScannerRegions(env) };
    },
    async probe(config) {
      let session: SandboxSession | undefined;
      try {
        session = await provider.openSession({ ...config, sessionTimeoutSeconds: Math.min(config.sessionTimeoutSeconds, PROBE_SESSION_TIMEOUT_SECONDS) }, { activityId: "startup-probe", unmetered: true });
        const result = await session.run!({ binary: "node", args: ["/app/worker/scripts/parser-vm-contract.mjs"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, readablePaths: [], inputPaths: [], writablePaths: [], limits: { timeoutMs: 30_000 } });
        const contract = result.exitCode === 0 ? JSON.parse(result.stdout) as { protocol?: unknown; uid?: unknown; tools?: unknown; links?: { hardlinks?: unknown; symlinks?: unknown }; hardening?: { suidDumpable?: unknown; ptraceScope?: unknown }; cgroupV2?: unknown; qpdfVersion?: unknown } : null;
        if (contract?.protocol !== "parser-vm@3") throw new Error("parser VM image contract unavailable");
        // Quarantine decrypts empty-user-password PDFs with the image's qpdf (runner.decryptPdfForScan); without a supported
        // one every such PDF would be refused, so the image is refused at startup instead.
        if (!supportedQpdfVersion(contract.qpdfVersion)) throw new Error(`parser VM qpdf is missing or older than ${MIN_PARSER_VM_QPDF} (${JSON.stringify(contract.qpdfVersion ?? null)})`);
        // Parser commands drop root in the VM (control.ts); a contract run as root means they would parse as root (N10).
        if (typeof contract.uid !== "number" || contract.uid === 0) throw new Error("parser VM commands do not drop root privileges");
        // Kernel link protections (council K #5, N #2): both must be reported exactly 1; off, absent, null or malformed fails.
        if (contract.links?.hardlinks !== 1 || contract.links?.symlinks !== 1) {
          throw new Error(`parser VM kernel link protections are not confirmed on (hardlinks=${JSON.stringify(contract.links?.hardlinks ?? null)}, symlinks=${JSON.stringify(contract.links?.symlinks ?? null)})`);
        }
        // Set-id core dumps off, and Yama ptrace restricted where present (recheck S #5): read back in the VM, or refused.
        if (contract.hardening?.suidDumpable !== 0) {
          throw new Error(`parser VM fs.suid_dumpable is not confirmed 0 (${JSON.stringify(contract.hardening?.suidDumpable ?? null)})`);
        }
        const ptrace = contract.hardening?.ptraceScope;
        if (ptrace !== null && !(typeof ptrace === "number" && ptrace >= 1)) {
          throw new Error(`parser VM kernel.yama.ptrace_scope is ${JSON.stringify(ptrace ?? null)}, not at least 1`);
        }
        console.log(`[parser-sandbox] provider=modal probe cgroup_v2=${contract.cgroupV2 === true} (per-command cgroup kill ${contract.cgroupV2 === true ? "available" : "unavailable: uid-wide kill only"})`);
        // Job paths are the worker's own temp paths, staged by the parser user (council M #3): every root must be creatable
        // and writable by uid 10001 in the VM, or every parser command would fail (real-Modal check F4).
        for (const root of parserJobRoots()) {
          const writable = await session.run!({ binary: "/bin/sh", args: ["-c", JOB_ROOT_WRITABLE_SCRIPT, "sh", root], env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, readablePaths: [], inputPaths: [], writablePaths: [], limits: { timeoutMs: 30_000 } });
          if (writable.exitCode !== 0) {
            throw new Error(`parser VM job root ${root} is not writable by the parser user (uid 10001); put TMPDIR and DOCSLURP_PARSER_SANDBOX_ROOT under a directory it can write, such as /tmp (docs/self-host/sandbox-providers.md)`);
          }
        }
        const tools = Array.isArray(contract.tools) ? contract.tools.filter((tool): tool is string => typeof tool === "string" && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(tool)) : undefined;
        return { ok: true, isolation: ISOLATION, detail: `VM image contract verified for '${config.app}'`, ...(tools ? { tools } : {}) };
      } catch (error) {
        return { ok: false, isolation: ISOLATION, detail: safeMessage(config, error) };
      } finally {
        // A slow terminate never decides the probe: close() has asked Modal to stop the VM (and retried with a fresh client),
        // and the probe VM's short lifetime ends it otherwise.
        await session?.close().catch((error: unknown) => console.warn(`[parser-sandbox] provider=modal probe VM terminate: ${safeMessage(config, error)}`));
      }
    },
    async openSession(config, context) {
      const scanner = context.scanner;
      if (scanner) {
        if (!scanner.tenantKey || !/^[0-9a-f]{64}$/.test(scanner.signatureSetHash) || !Number.isSafeInteger(scanner.expectedVersion) || scanner.expectedVersion <= 0) {
          throw new SandboxPolicyError("invalid scanner session: an organization, a signature set hash and its version are required");
        }
      }
      const { sdk, client } = await loadClient(config);
      const maxLanes = Math.max(1, Math.floor(config.vmsPerActivity ?? 1));
      const idleMs = Math.max(0.01, config.vmIdleSeconds ?? 20) * 1000;
      const vmBudget = (budget ??= new VmBudget(Math.max(1, Math.floor(config.vmsPerWorker ?? Number.MAX_SAFE_INTEGER))));
      let closed = false;
      let clientClosed = false;
      /** The one document a scanner session serves (bound by its first command). */
      let scannerDocument: string | undefined;

      async function terminateLate(created: import("modal").Sandbox, freshClient = clientClosed): Promise<boolean> {
        const cleanupClient = freshClient ? new sdk.ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret }) : client;
        try { await withDeadline(new sdk.Sandbox(cleanupClient, created.sandboxId).terminate(), TERMINATE_REQUEST_MS); return true; }
        catch { console.warn("[parser-sandbox] late VM cleanup failed; provider lifetime limit remains enforced"); return false; }
        finally { if (cleanupClient !== client) cleanupClient.close(); }
      }

      /**
       * Meter a VM's time since it was last metered (VM pool follow-up): its start-up and any idle time before a command
       * are billed with that command, and the time after its last command with its termination (meterTail). The events
       * of one VM tile its life from creation to terminate, which is what Modal bills. Logged, and returned as a
       * provider-cost usage event (none for an unmetered session).
       */
      function meterLane(lane: { accountedAt: number | undefined }, kind = "command", now = Date.now()): UsageEvent | undefined {
        const wallSeconds = lane.accountedAt === undefined ? 0 : Math.max(0, now - lane.accountedAt) / 1000;
        if (lane.accountedAt !== undefined) lane.accountedAt = now;
        console.log(
          `[sandbox-usage] provider=modal kind=${kind} cpu_seconds=${(config.cpu * wallSeconds).toFixed(3)} memory_gb_seconds=${((config.memoryMb / 1024) * wallSeconds).toFixed(3)} activity=${context.activityId}`,
        );
        if (context.unmetered) return undefined;
        return buildModalUsageEvent(config, context.activityId, wallSeconds);
      }

      /**
       * One parser VM of this activity's pool (recheck R #5). A lane runs one command at a time (council O #4): staging,
       * the run, the root leftover kill and the download never overlap another command in the same VM, so the user-wide
       * kill can never hit a command that is starting or running. Concurrent work gets its own lane, up to maxLanes.
       */
      interface Lane {
        id: number;
        /** Leased to a command (acquireLane); a lane is never shared by two commands at once. */
        busy: boolean;
        /** Terminated (a failed leftover kill or deadline, or close): never leased again. */
        dead: boolean;
        /** The affinity key of its last command: a document's later commands prefer the VM that holds its inputs. */
        lastKey: string | undefined;
        /** The key of the command before the current one (who left the job tree as it is). */
        previousKey: string | undefined;
        /** A new document on this VM: its inputs are uploaded afresh (recheck S #7). */
        forgetUploads(): void;
        /** When the VM's time was last metered; undefined until it is created (it holds a budget token from then). */
        accountedAt: number | undefined;
        /** Records the VM's last metered stretch into the usage ledger of the stage that ran its last command. */
        recorder: ((event: UsageEvent) => void) | undefined;
        idleTimer: NodeJS.Timeout | undefined;
        /** Take this lane's worker VM token before the command is admitted (abortable; a no-op once it holds one). */
        reserve(signal?: AbortSignal): Promise<void>;
        ensureSandbox(): Promise<void>;
        execute(command: SandboxCommand, started: number, signal?: AbortSignal): Promise<SandboxResult>;
        terminate(): Promise<void>;
      }

      let laneCount = 0;
      function createLane(): Lane {
        let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;
        let staging: SessionStaging | undefined;
        let creating: Promise<void> | undefined;
        let terminating: Promise<void> | undefined;
        const lane: Lane = { id: ++laneCount, busy: false, dead: false, lastKey: undefined, previousKey: undefined, accountedAt: undefined, recorder: undefined, idleTimer: undefined, reserve, ensureSandbox, execute, terminate, forgetUploads: () => staging?.forgetUploads() };
        let holdsToken = false;
        /**
         * When Modal's create call returned (council V #1): the VM's own lifetime limit started no later than this, so a VM
         * whose terminate is unconfirmed is gone by lifetimeStart + sessionTimeoutSeconds (+ margin). Metering starts at
         * the same moment (lane.accountedAt, real-Modal M1); the worker token is held from the creation request.
         */
        let lifetimeStart: number | undefined;
        /** When this lane asked Modal for its VM: the unconfirmed-creation backstop counts from here (council X #5). */
        let createRequestedAt: number | undefined;
        let rawCreate: Promise<unknown> | undefined;
        let terminateDone = false;

        async function reserve(signal?: AbortSignal): Promise<void> {
          if (holdsToken || sandbox || lane.dead) return;
          let handOver = false;
          await vmBudget.acquire(() => {
            if (closed || lane.dead) return true;
            // This activity's own VM went idle while this command waited for a worker token: take it over rather than
            // have the budget terminate it and start another (real-Modal P2). Same activity, so no wipe is needed.
            if (idleWithVm()) { handOver = true; return true; }
            return false;
          }, signal, budgetMember).catch((error: unknown) => {
            if (handOver) throw new HandOver();
            throw error;
          });
          if (closed || lane.dead) { vmBudget.release(); throw new SandboxInfrastructureError("modal sandbox session is closed"); }
          holdsToken = true;
        }

        /** Record the VM's time since it was last metered, up to `until`, where its last command's stage can see it. */
        function recordTail(until: number): void {
          // Metering never stands in the way of the terminate (a pricing failure is logged, the VM still stops).
          if (lane.accountedAt === undefined) return;
          try {
            const tail = meterLane(lane, "idle", Math.max(until, lane.accountedAt));
            if (tail) {
              if (lane.recorder) lane.recorder(tail);
              else console.warn(`[sandbox-usage] provider=modal status=unrecorded reason=no-stage activity=${context.activityId} wall_seconds=${tail.metadata?.wallSeconds ?? "?"}`);
            }
          } catch (error) {
            console.error(`[sandbox-usage] provider=modal status=unrecorded reason=meter-failed activity=${context.activityId}: ${safeMessage(config, error)}`);
          }
        }

        /** After a failed create: stop a VM Modal may have made under `name` anyway. Logged; never throws. */
        async function reapOrphan(name: string, createError: unknown): Promise<void> {
          try {
            const orphan = await withDeadline(client.sandboxes.fromName(config.app, name), 10_000);
            await withDeadline(orphan.terminate(), TERMINATE_REQUEST_MS);
            console.error(`[parser-sandbox] provider=modal status=orphan-vm-terminated activity=${context.activityId} after a failed create: ${safeMessage(config, createError)}`);
          } catch (lookup) {
            if (typeof sdk.NotFoundError === "function" && lookup instanceof sdk.NotFoundError) return;
            console.warn(`[parser-sandbox] provider=modal status=orphan-vm-lookup-failed activity=${context.activityId}: ${safeMessage(config, lookup)}`);
          }
        }

        function releaseToken(): void {
          if (holdsToken) { holdsToken = false; vmBudget.release(); }
        }

        /**
         * Termination could not be confirmed (recheck T #1): the VM may run until Modal's own lifetime limit ends it, so it
         * is billed to that bound and its worker token stays taken until then; the worker never runs past its cap.
         */
        function quarantine(reason: string): void {
          const lifetimeMs = config.sessionTimeoutSeconds * 1000;
          const expiry = (lifetimeStart ?? Date.now()) + lifetimeMs + Math.min(LIFETIME_MARGIN_MS, lifetimeMs * 0.1);
          console.error(`[parser-sandbox] provider=modal status=vm-quarantined reason=${reason} activity=${context.activityId} release_in_ms=${Math.max(0, expiry - Date.now())}`);
          recordTail(expiry);
          if (holdsToken) setTimeout(releaseToken, Math.max(0, expiry - Date.now())).unref();
        }

        /**
         * Stop the VM. Its metering and its worker token run until Modal acknowledges the terminate (recheck T #1): a VM
         * still being created is waited for first, and one whose terminate (or creation) cannot be confirmed is quarantined.
         */
        function terminate(): Promise<void> {
          lane.dead = true;
          if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = undefined; }
          terminating ??= (async () => {
            try {
              if (creating) await creating.catch(() => {});
              if (rawCreate) {
                let settled = false;
                await Promise.race([rawCreate.then(() => { settled = true; }), new Promise((resolve) => setTimeout(resolve, config.createSettleMs ?? CREATE_SETTLE_MS).unref())]);
                if (!settled) {
                  // No VM may exist yet, or one may: hold its worker token until the create call settles (council V #1). The
                  // create's own handlers then stop a late VM and release the token, or quarantine it from its real start.
                  terminateDone = true;
                  console.error(`[parser-sandbox] provider=modal status=vm-creation-unconfirmed activity=${context.activityId}; holding its capacity until the create call settles`);
                  // Backstop (council W #6): a create call that never settles cannot hold the token forever. Any VM it made
                  // started before now and Modal stops it within its lifetime, so the token is free after that and margins.
                  // Measured from the create request (council X #5): the cap holds however long terminate took to give up.
                  const lifetimeMs = config.sessionTimeoutSeconds * 1000;
                  const backstopMs = config.unconfirmedBackstopMs ?? lifetimeMs + Math.min(LIFETIME_MARGIN_MS, lifetimeMs * 0.1) + CREATE_DEADLINE_MS;
                  setTimeout(() => {
                    if (!holdsToken) return;
                    console.error(`[parser-sandbox] provider=modal status=vm-creation-backstop activity=${context.activityId}; releasing capacity after the VM lifetime`);
                    releaseToken();
                  }, Math.max(0, (createRequestedAt ?? Date.now()) + backstopMs - Date.now())).unref();
                  throw new Error("modal sandbox creation did not settle; its capacity stays held until it does");
                }
              }
              if (sandbox) {
                try {
                  // Ask Modal to stop the VM; waiting for its exit is not needed (and an image process that ignores signals
                  // could hold a wait for tens of seconds).
                  await withDeadline(sandbox.terminate(), TERMINATE_REQUEST_MS);
                } catch (failure) {
                  // Retry once on a fresh client so a stuck connection cannot leave the VM running.
                  if (!(await terminateLate(sandbox, true))) {
                    quarantine("terminate-unconfirmed");
                    throw new Error(`modal sandbox terminate failed: ${safeMessage(config, failure)}`);
                  }
                }
              }
              recordTail(Date.now());
              releaseToken();
            } finally {
              terminateDone = true;
            }
          })();
          return terminating;
        }

        function ensureSandbox(): Promise<void> {
          creating ??= (async () => {
            if (!holdsToken) { await vmBudget.acquire(() => closed || lane.dead); holdsToken = true; }
            if (closed || lane.dead) throw new Error("parser VM session closed during creation");
            // A unique name, so a VM whose create call failed in transit can be found and stopped (council W #6).
            const name = `docslurp-parser-${randomBytes(12).toString("hex")}`;
            // A scanner session restores each VM from its clean snapshot (built once per signature set, before any job
            // input exists); every other session creates a fresh VM from the image.
            let scannerKey: string | undefined;
            let scannerSnapshot: Promise<import("modal").SandboxSnapshot> | undefined;
            if (scanner) {
              scannerKey = scannerSnapshotKey(config, config, config.scannerRegions ?? ["us"], scanner);
              // The build serves every later organization's scans, so its VM time is platform cost, logged for SigNoz, never
              // recorded against the organization whose scan happened to trigger it (council L3).
              scannerSnapshot = scannerSnapshots.get(scannerKey, () => buildScannerSnapshot(sdk, client, config, scanner, (event) => {
                if (!event) return;
                const metadata = event.metadata as { wallSeconds?: number; providerCostCents?: number } | undefined;
                console.log(`[sandbox-usage] provider=modal status=platform kind=scanner-build wall_seconds=${(metadata?.wallSeconds ?? 0).toFixed(3)} provider_cost_cents=${(metadata?.providerCostCents ?? 0).toFixed(4)} signature_set=${scanner.signatureSetHash.slice(0, 16)}`);
              }));
              await scannerSnapshot;
              if (closed || lane.dead) throw new Error("parser VM session closed during creation");
            }
            const app = scanner ? undefined : await withDeadline(client.apps.fromName(config.app, { createIfMissing: true }), 30_000);
            const registrySecret = !scanner && config.registrySecret && !config.imageId ? await withDeadline(client.secrets.fromName(config.registrySecret), 30_000) : undefined;
            const image = scanner ? undefined : config.imageId ? await withDeadline(client.images.fromId(config.imageId), 30_000) : client.images.fromRegistry(config.image, registrySecret);
            createRequestedAt = Date.now();
            const create = (scanner
              ? client.sandboxes.experimentalFromSnapshot(await scannerSnapshot!, { name }).catch((error: unknown) => {
                // A snapshot that no longer restores (expired, region gone) is rebuilt by the next scan.
                scannerSnapshots.forget(scannerKey!, scannerSnapshot);
                throw error;
              })
              : client.sandboxes.create(app!, image!, {
              name,
              runtime: "vm",
              command: [...PARSER_VM_IDLE_COMMAND],
              includeOidcIdentityToken: false,
              env: {}, secrets: [], volumes: {}, cloudBucketMounts: {},
              cpu: config.cpu, cpuLimit: config.cpu,
              memoryMiB: config.memoryMb, memoryLimitMiB: config.memoryMb,
              timeoutMs: config.sessionTimeoutSeconds * 1000,
              blockNetwork: true,
            })).then(async (created) => {
              lifetimeStart = Date.now();
              // Billing starts when Modal's create returns, as Modal bills it (real-Modal M1: metering from the request
              // overstated 4-9 s VMs by about a second each). Capacity accounting is unchanged: the token is held from the
              // request, and quarantine still bounds a VM's life from lifetimeStart (council V #1).
              lane.accountedAt = lifetimeStart;
              // A VM that arrives after this lane's terminate finished is stopped here (its capacity was held for it); any
              // other is the lane's own, and terminate() stops it (it waits for this call first).
              if (terminateDone) {
                if (await terminateLate(created)) { recordTail(Date.now()); releaseToken(); }
                else quarantine("late-vm-terminate-unconfirmed");
                throw new Error("parser VM session closed during creation");
              }
              sandbox = created;
              return created;
            }, async (error: unknown) => {
              // The create failed, but a transport failure can hide a VM Modal made: look it up by name and stop it
              // (council W #6), best effort. Then no VM is assumed, and a capacity held for an unconfirmed creation is free.
              await reapOrphan(name, error);
              if (terminateDone) { recordTail(Date.now()); releaseToken(); }
              throw error;
            });
            rawCreate = create.catch(() => {});
            const opened = await withDeadline(create, CREATE_DEADLINE_MS);
            if (closed || lane.dead) throw new Error("parser VM session closed during creation");
            if (!opened) throw new Error("parser VM creation returned no sandbox");
            // As root, once: kernel link protections on and read back as 1, or this VM runs nothing (council K #5, Modal check).
            // A restored scanner VM was hardened before its snapshot; this re-applies and reads the settings back all the same.
            const hardened = await withDeadline(opened.exec(HARDEN_LINKS_ARGV, { timeoutMs: 10_000 }).then((proc) => proc.wait()), 15_000);
            if (hardened !== 0) throw new Error("parser VM kernel link protections could not be turned on");
            if (scanner) {
              // A restored VM's isolation comes from the snapshot through an experimental API that takes no network
              // option: prove from root that it cannot reach the internet before it runs anything (council L1).
              const egress = await withDeadline(opened.exec(RESTORED_EGRESS_CHECK_ARGV, { timeoutMs: 15_000 }).then((proc) => proc.wait()), 20_000);
              if (egress !== 0) throw new Error(`restored scanner VM is not network-blocked (egress check exit ${egress}); refusing it`);
              console.log(`[parser-sandbox] provider=modal status=scanner-vm-restored egress=blocked activity=${context.activityId}`);
              // The image lock and the control directory are part of the snapshot, taken before any command could change
              // them (scanner.ts); the restored VM is that state, byte for byte.
              staging = new SessionStaging(buildRemoteFs(sdk, opened));
              return;
            }
            // As root, once: the image's runtime root-owned, then nothing outside scratch writable by the parser user
            // (council W #1), or this VM runs nothing.
            const locked = await withDeadline(opened.exec(lockImageArgv(parserJobRoots()), { timeoutMs: 120_000 }).then((proc) => proc.wait()), 125_000);
            if (locked !== 0) throw new Error("parser VM image paths are writable by the parser user");
            await withDeadline(opened.filesystem.makeDirectory(CONTROL_DIR), 30_000);
            // Root-owned and not writable by the parser user; uploads staged here are copied into place as uid 10001.
            await withDeadline(runChecked(opened, ["/bin/chmod", "0711", "--", CONTROL_DIR], "parser VM control directory setup failed"), 30_000);
            staging = new SessionStaging(buildRemoteFs(sdk, opened));
          })();
          // A VM that could not be created or hardened is never used: terminate it and let the pool replace the lane.
          creating.catch(() => { terminate().catch(() => {}); });
          return creating;
        }

        /**
         * Kill a command's remote process group, then wait (bounded) for its exec to end. Best
         * effort: a sandbox that is already gone has nothing left to kill.
         *
         * The caller settles (and releases its local slot) after this, even if a remote descendant
         * that started its own session survived the group kill. That is safe for the worker host:
         * the survivor runs only inside this lane's Modal VM, cannot reach local scratch, and is
         * killed by the root leftover kill before the lane takes another command.
         */
        async function kill(control: string, settled: Promise<unknown>): Promise<void> {
          try {
            const killer = await sandbox!.exec(killArgv(control), { timeoutMs: KILL_SETTLE_MS });
            await killer.wait();
          } catch (error) {
            console.warn(`[parser-sandbox] provider=modal kill failed: ${safeMessage(config, error)}`);
          }
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            settled.catch(() => {}),
            new Promise((resolve) => (timer = setTimeout(resolve, KILL_SETTLE_MS))),
          ]);
          clearTimeout(timer);
        }

        async function runRemote(command: SandboxCommand, control: string, signal?: AbortSignal): Promise<RemoteOutcome> {
          const env: Record<string, string> = {};
          for (const [key, value] of Object.entries(command.env)) if (value !== undefined) env[key] = value;
          const argv = launchArgv(control, command.binary, command.args, command.writablePaths);
          let settled: Promise<{ stdout: string; stderr: string; exitCode: number | null }> = Promise.reject(
            new Error("exec did not start"),
          );
          settled.catch(() => {});
          const aborted = whenAborted(signal);
          try {
            const process = await sandbox!.exec(argv, { env, timeoutMs: execTimeoutMs(command.limits.timeoutMs), mode: "text" });
            // A command that floods its stdout or stderr past the bound is the document's doing (recheck S #2).
            settled = Promise.all([boundedJobOutput(process.stdout, 8 * 1024 * 1024, "parser command stdout").then((bytes) => bytes.toString("utf8")), boundedJobOutput(process.stderr, 1024 * 1024, "parser command stderr").then((bytes) => bytes.toString("utf8")), process.wait()]).then(
              ([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }),
            );
            settled.catch(() => {});
            const first = await Promise.race([settled, aborted.promise]);
            if (first !== "aborted") return { kind: "exited", output: first };
          } catch (error) {
            // Modal enforces the exec timeout provider-side, but may stop only the top process.
            // Every other failure is a provider error and propagates.
            await kill(control, settled);
            // An abort that lands while the exec is starting can surface as an exec error.
            if (signal?.aborted) return { kind: "aborted" };
            if (isExecTimeout(sdk, error)) return { kind: "timeout" };
            throw error;
          } finally {
            aborted.dispose();
          }
          await kill(control, settled);
          return { kind: "aborted" };
        }

        /** Changes left by aborted and timed-out commands, removed before the lane takes another command. */
        const pendingDiscards: RemoteSnapshot[] = [];

        async function runDiscards(): Promise<void> {
          // A terminated VM's changes are gone with it.
          while (pendingDiscards.length > 0 && !lane.dead) {
            try {
              await staging!.discard(pendingDiscards.shift()!);
            } catch (error) {
              // Partial outputs that could not be removed must never reach a later command's download: the VM is
              // terminated instead, and the next command gets a fresh one (recheck Q #8).
              console.error(`[parser-sandbox] provider=modal discard failed; terminating the VM: ${safeMessage(config, error)}`);
              pendingDiscards.length = 0;
              await terminate().catch(() => {});
            }
          }
        }

        /**
         * Kill every process the parser user still runs (council M #3): a daemon a command left behind could otherwise act
         * on the next command. As root, so it needs no fork as the parser user (RLIMIT_NPROC cannot stop it), and verified:
         * a parser-user process left alive terminates this VM (council O #4).
         */
        async function killParserUserProcesses(): Promise<void> {
          let code: number | null = null;
          let transport: unknown;
          try {
            const proc = await sandbox!.exec(KILL_PARSER_USER_ARGV, { timeoutMs: KILL_SETTLE_MS * 3 });
            code = await withDeadline(proc.wait(), KILL_SETTLE_MS * 3 + 5_000);
          } catch (error) {
            console.error(`[parser-sandbox] provider=modal leftover kill failed: ${safeMessage(config, error)}`);
            // A kill that ran out of time, Modal's exec timeout or our own deadline, was held up inside the VM (a stopped
            // or flooding leftover): that is the job's (council X #2), never a transport error.
            if (!isExecTimeout(sdk, error) && !isControlDeadline(error)) transport = error;
          }
          if (code !== 0) {
            await terminate().catch(() => {});
            // Only the exec failing to run is the sandbox's. Processes the command left that survive the kill, or that stall
            // it, are its document's doing (recheck S #2b): that document fails, once; the VM is gone either way.
            if (transport !== undefined) throw new SandboxInfrastructureError("parser VM leftover kill could not run; VM terminated", undefined, { cause: transport });
            throw new SandboxOutputError("processes this document's parser command left in the VM could not be killed; VM terminated");
          }
        }

        /**
         * After every command, as root (council W #1, W #3, U #8): wipe everything the parser user wrote outside the image
         * (scratch roots and job roots, so the command's uploads and outputs too), then check the disk. The next command,
         * of any document, starts from the image. A VM that cannot be wiped or is left unusable is terminated, and the
         * command that just ran takes the strike; a reset that cannot run at all is Modal's.
         */
        /** The document whose uploaded inputs the last reset kept on this VM (council X #7). */
        let keptFor: string | undefined;

        async function resetVm(keepFor?: string): Promise<void> {
          // The same document's next command reuses its inputs; any other document gets a full wipe first (W #3 holds).
          const keep = keepFor !== undefined ? staging?.uploadedPaths() ?? [] : [];
          let code: number | null = null;
          let transport: unknown;
          let overran = false;
          try {
            const proc = await sandbox!.exec(resetArgv(parserJobRoots(), keep), { timeoutMs: RESET_DEADLINE_MS });
            code = await withDeadline(proc.wait(), RESET_DEADLINE_MS + 5_000);
          } catch (error) {
            console.error(`[parser-sandbox] provider=modal reset failed: ${safeMessage(config, error)}`);
            // A wipe that outlives its deadline (a command that left millions of files) is that command's doing (council
            // X #2): it must not pass for a transport error and dodge the strike.
            if (isExecTimeout(sdk, error) || isControlDeadline(error)) overran = true;
            else transport = error;
          }
          // Unless kept for the same document, nothing staged earlier may be assumed present any more.
          keptFor = code === 0 && keep.length ? keepFor : undefined;
          if (keptFor === undefined) staging?.forgetUploads();
          if (code === 0) return;
          await terminate().catch(() => {});
          if (transport !== undefined) throw new SandboxInfrastructureError("parser VM reset could not run; VM terminated", undefined, { cause: transport });
          // Only a command that ran can have left what broke the reset; a reset after staging alone strikes no one.
          throw new SandboxInfrastructureError(`parser VM ${overran ? "scratch wipe ran past its deadline" : code === 5 ? "disk or job root unusable" : "scratch could not be wiped"} after this document's command; VM terminated`, undefined, { afterCommand: commandRan });
        }

        /** The job roots as the next document's staging finds them; a broken one blames `previous` (council X #1). */
        async function probeJobTree(previous: string): Promise<void> {
          let code: number | null = null;
          try {
            const proc = await sandbox!.exec([...asParserUser(), "/bin/sh", "-c", JOB_TREE_PROBE_SCRIPT, "sh", ...parserJobRoots()], { timeoutMs: 30_000 });
            code = await proc.wait();
          } catch (error) {
            throw new SandboxInfrastructureError(`modal sandbox job tree probe could not run: ${safeMessage(config, error)}`, meterLane(lane), { cause: error });
          }
          if (code === 0) return;
          await terminate().catch(() => {});
          throw new SandboxInfrastructureError("modal sandbox job tree left unusable by an earlier command (missing, replaced or wrong owner); VM terminated", meterLane(lane), { blameDocumentId: previous });
        }

        let commandCount = 0;

        /**
         * Whether the current document caused what failed: its own command started (council U #4), or the staging of its
         * own inputs and job tree had begun (council W #2). Only such failures are its strikes.
         */
        let commandRan = false;
        let ownStaging = false;

        async function execute(command: SandboxCommand, started: number, signal?: AbortSignal): Promise<SandboxResult> {
          let cleaned = false;
          commandRan = false;
          ownStaging = false;
          try {
            // Read-only assets (the ClamAV definitions) are the worker's, not the document's: staged under their own
            // deadline, outside the command's control deadline, and their failure strikes no one (council W #2).
            if (command.readOnlyAssetDir) {
              try {
                await ensureSandbox();
                command = await withDeadline(withAssets(command), ASSET_STAGING_DEADLINE_MS);
              } catch (error) {
                if (error instanceof SandboxRunError) throw error;
                throw new SandboxInfrastructureError(`modal sandbox read-only asset staging failed: ${safeMessage(config, error)}`, meterLane(lane), { cause: error });
              }
            }
            try {
              return await withDeadline(executeCommand(command, started, signal, () => { cleaned = true; }), command.limits.timeoutMs + 60_000);
            } catch (error) {
              if (error instanceof Error && error.message === "parser VM control deadline exceeded") {
                await terminate().catch(() => {});
                throw new SandboxInfrastructureError(error.message, meterLane(lane), { cause: error, afterCommand: commandRan || ownStaging });
              }
              throw error;
            }
          } finally {
            // Before the lane is leased again: leftovers die (unless the command already killed them before its download),
            // then an abandoned command's partial outputs are removed.
            if (sandbox && !lane.dead && !closed && !cleaned) await killParserUserProcesses();
            if (pendingDiscards.length > 0 && !lane.dead && !closed) await runDiscards();
            if (sandbox && !lane.dead && !closed) await resetVm(command.affinityKey);
          }
        }

        /**
         * Read-only assets in this VM (real-Modal P1), by content-named directory: staged once by root under ASSET_ROOT
         * (directories 0755, files 0444), so the parser user reads them but can never change them for a later document,
         * and outside every job tree, so no upload, discard or download touches them.
         */
        const assetDirs = new Map<string, Promise<string>>();
        function ensureAssetDir(hostDir: string): Promise<string> {
          const name = path.basename(hostDir);
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return Promise.reject(new Error("invalid read-only asset directory name"));
          let staged = assetDirs.get(name);
          if (!staged) {
            // One VM at a time per worker reads the definitions into memory, file by file (council W #7).
            staged = withAssetStagingSlot(async () => {
              const vmDir = `${ASSET_ROOT}/${name}`;
              await withDeadline(sandbox!.filesystem.makeDirectory(vmDir), 30_000);
              const files: string[] = [];
              let total = 0;
              for (const entry of await readdir(hostDir, { withFileTypes: true })) {
                if (!entry.isFile()) continue;
                const data = await readFile(path.join(hostDir, entry.name));
                total += data.byteLength;
                if (total > 512 * 1024 * 1024) throw new Error("read-only assets exceed transfer limit");
                // Each write has its own deadline (council X #5), so one stuck transfer cannot hold the worker's staging slot.
                await withDeadline(sandbox!.filesystem.writeBytes(data, `${vmDir}/${entry.name}`), config.assetWriteDeadlineMs ?? ASSET_WRITE_DEADLINE_MS);
                files.push(`${vmDir}/${entry.name}`);
              }
              await runChecked(sandbox!, ["/bin/chmod", "0755", "--", ASSET_ROOT, vmDir], "parser VM asset directory setup failed");
              if (files.length) await runChecked(sandbox!, ["/bin/chmod", "0444", "--", ...files], "parser VM asset setup failed");
              return vmDir;
            });
            assetDirs.set(name, staged);
            staged.catch(() => assetDirs.delete(name));
          }
          return staged;
        }

        /** The command with its read-only asset paths mapped into the VM, and those paths out of its uploads. */
        async function withAssets(command: SandboxCommand): Promise<SandboxCommand> {
          if (!command.readOnlyAssetDir) return command;
          const hostDir = path.resolve(command.readOnlyAssetDir);
          const vmDir = await ensureAssetDir(hostDir);
          const under = (p: string) => p === hostDir || p.startsWith(`${hostDir}/`);
          return {
            ...command,
            args: command.args.map((arg) => (under(arg) ? `${vmDir}${arg.slice(hostDir.length)}` : arg)),
            inputPaths: command.inputPaths.filter((p) => !under(p)),
          };
        }

        async function executeCommand(original: SandboxCommand, started: number, signal: AbortSignal | undefined, markCleaned: () => void): Promise<SandboxResult> {
          const control = `${CONTROL_DIR}/${++commandCount}`;
          let command = original;
          /** Whether this command's own process ran: a staging failure before that may be another document's doing. */
          let ran = false;
          try {
            await ensureSandbox();
            throwIfAborted(signal);
            command = await withAssets(command);
            // On a VM another document used last, check its job roots first (council X #1): missing-and-uncreatable,
            // replaced (not a directory, a link) or owned by someone else is the previous document's doing.
            // Another document's inputs kept on this VM go first: the next document sees nothing of them (council X #7, W #3).
            if (keptFor !== undefined && keptFor !== command.affinityKey) await resetVm();
            if (lane.previousKey !== undefined && lane.previousKey !== command.affinityKey) await probeJobTree(lane.previousKey);
            // Only the command's inputs travel; the parser runtime comes from the image. From here a failure the VM itself
            // reports (no space, the document's own staging timing out) is this document's doing (council W #2).
            ownStaging = true;
            await staging!.ensureUploaded(command.inputPaths);
            throwIfAborted(signal);
            // Its writable paths and its own HOME, temp and XDG directories (outside its writable paths, so never downloaded,
            // and wiped after it), in one exec (council X #7).
            const scratch = `${parserJobRoots()[1] ?? "/tmp/docslurp-parser-sandbox"}/.cmd-${lane.id}-${commandCount}`;
            await staging!.ensureDirectories([...command.writablePaths, ...commandScratchDirs(scratch)]);
            command = { ...command, env: { ...command.env, ...commandScratchEnv(scratch) } };
            throwIfAborted(signal);
            const snapshot = await staging!.snapshot(command.writablePaths);
            throwIfAborted(signal);
            let outcome: RemoteOutcome;
            try {
              ran = true;
              commandRan = true;
              outcome = await runRemote(command, control, signal);
            } catch (error) {
              pendingDiscards.push(snapshot);
              throw error;
            }
            if (outcome.kind === "exited" && !signal?.aborted) {
              // Leftover processes die before anything is read back (council M #3).
              await killParserUserProcesses();
              markCleaned();
              // Only what this command created or changed comes back.
              if (closed || lane.dead) throw new Error("parser VM session closed before download");
              await staging!.download(snapshot);
              const usage = meterLane(lane);
              return { ...outcome.output, cpuSeconds: config.cpu * ((Date.now() - started) / 1000), usage };
            }
            // Aborted or timed out: its outputs may be partial. Never download them, and remove
            // them remotely so no later command's download copies them back.
            pendingDiscards.push(snapshot);
            if (outcome.kind !== "timeout") throw new CommandAborted();
            const usage = meterLane(lane);
            return {
              stdout: "",
              stderr: "command exceeded its time limit",
              exitCode: null,
              cpuSeconds: config.cpu * ((Date.now() - started) / 1000),
              usage,
            };
          } catch (error) {
            // Elapsed Modal time is billed even when staging or exec failed.
            if (error instanceof CommandAborted) throw new SandboxRunError("modal sandbox command aborted", meterLane(lane));
            if (error instanceof SandboxOutputError) {
              // The VM's disk and processes are no longer trusted: it runs nothing more (recheck S #3).
              await terminate().catch(() => {});
              // Only the job-tree probe blames the previous document (council X #1); it throws its own error, below.
              // After its command ran, or a size limit on its own files: this document's verdict, never retried (recheck Q #1).
              if (ran || /exceeds (?:its )?limit/.test(error.message)) throw new SandboxOutputError(error.message, meterLane(lane), { cause: error });
              // Anything else this document's own staging hit (a cp or mkdir in its job tree that the VM refused, an
              // unreadable or unlistable output) is its strike: retried on a fresh VM, failed at the limit (council X #1).
              throw new SandboxInfrastructureError(`modal sandbox staging failed for this document: ${error.message}; VM terminated`, meterLane(lane), { cause: error, afterCommand: true });
            }
            // Anything else that throws here is the sandbox's: SDK and transport errors, control commands, VM creation and
            // hardening, the leftover kill, a closed session (a document's own failure is a non-zero exit or the above).
            // It counts toward the document's strikes only after its own command ran (council U #4); an error that already
            // says whether it does (a leftover kill that could not run is Modal's) keeps that.
            // Staging the document's own inputs that the VM refuses for lack of space is the document's too (council W #2);
            // a Modal API or transport error during staging is not.
            // An infrastructure error that already says whom it strikes (the job-tree probe's blame) passes through unchanged.
            if (error instanceof SandboxInfrastructureError && error.blameDocumentId !== undefined) throw error;
            const afterCommand = error instanceof SandboxInfrastructureError ? error.afterCommand : ran || (ownStaging && isOwnStagingFailure(error));
            throw new SandboxInfrastructureError(`modal sandbox command failed: ${safeMessage(config, error)}`, meterLane(lane), { cause: error, afterCommand });
          }
        }

        return lane;
      }

      /** The pool: lanes in creation order, and commands waiting for one (FIFO). */
      const lanes: Lane[] = [];
      const waiting: Array<() => void> = [];

      function addLane(): Lane {
        const lane = createLane();
        lanes.push(lane);
        return lane;
      }

      /**
       * A new lane only under the activity's cap, and, unless the pool has no live lane, only while the worker has a free
       * VM token or another activity holds an idle VM to give up: otherwise the command waits for one of this pool's own
       * VMs (recheck T #2).
       */
      function canGrow(): boolean {
        const live = lanes.filter((candidate) => !candidate.dead).length;
        return live < maxLanes && (live === 0 || vmBudget.available(budgetMember));
      }

      function pickLane(key: string | undefined): Lane | undefined {
        const idle = lanes.filter((lane) => !lane.busy && !lane.dead);
        // Its key's VM first, then any idle lane that already has a VM (one without would need a new VM and a token).
        const lane = (key ? idle.find((candidate) => candidate.lastKey === key && candidate.accountedAt !== undefined) : undefined)
          ?? idle.find((candidate) => candidate.accountedAt !== undefined) ?? idle[0]
          ?? (canGrow() ? addLane() : undefined);
        if (lane) {
          lane.busy = true;
          lane.previousKey = lane.lastKey;
          lane.lastKey = key;
          // Another document's parser ran here last and could have rewritten this one's remote inputs (recheck S #7).
          if (lane.previousKey !== key) lane.forgetUploads();
          if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = undefined; }
        }
        return lane;
      }

      /** Lease a lane for one command: an idle one (its key's first), a new one under the cap, or wait for a release. */
      async function acquireLane(key: string | undefined, signal?: AbortSignal): Promise<Lane> {
        for (;;) {
          if (closed) throw new SandboxInfrastructureError("modal sandbox session is closed");
          if (signal?.aborted) throw new SandboxRunError("modal sandbox command aborted");
          if (waiting.length === 0) {
            const lane = pickLane(key);
            if (lane) return lane;
          }
          await new Promise<void>((resolve) => {
            const wake = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
            const onAbort = () => { const index = waiting.indexOf(wake); if (index >= 0) waiting.splice(index, 1); resolve(); };
            signal?.addEventListener("abort", onAbort, { once: true });
            waiting.push(wake);
          });
          if (!closed && !signal?.aborted) {
            const lane = pickLane(key);
            if (lane) { wakeNext(); return lane; }
            // Woken but nothing free (a release raced another lease): wait again.
          }
        }
      }

      function wakeNext(): void {
        const live = lanes.filter((lane) => !lane.dead);
        if (waiting.length > 0 && (live.some((lane) => !lane.busy) || canGrow())) waiting.shift()!();
      }

      function releaseLane(lane: Lane): void {
        lane.busy = false;
        // A command of this activity waiting for a worker token may take this VM over (real-Modal P2).
        if (!lane.dead && lane.accountedAt !== undefined) vmBudget.wake();
        if (lane.dead) lanes.splice(lanes.indexOf(lane), 1);
        else if (!closed) {
          // Idle VMs are reaped: Modal bills them until terminated (VM pool follow-up).
          lane.idleTimer = setTimeout(() => { lane.idleTimer = undefined; if (!lane.busy && !lane.dead) void reap(lane); }, idleMs);
          lane.idleTimer.unref();
        }
        wakeNext();
      }

      /** Terminate an idle VM and drop it from the pool; a later command opens a fresh one. */
      function reap(lane: Lane): Promise<void> {
        const terminated = lane.terminate().catch((error: unknown) => console.warn(`[parser-sandbox] provider=modal idle VM terminate: ${safeMessage(config, error)}`));
        const index = lanes.indexOf(lane);
        if (index >= 0) lanes.splice(index, 1);
        wakeNext();
        return terminated;
      }

      // Another activity on this worker needs a VM and none is free: give up one idle VM of this pool.
      const idleWithVm = () => lanes.find((lane) => !lane.busy && !lane.dead && lane.accountedAt !== undefined);
      const budgetMember = {
        hasIdle: () => idleWithVm() !== undefined,
        reapIdle: () => {
          const idle = idleWithVm();
          if (!idle) return false;
          void reap(idle);
          return true;
        },
      };
      const unregisterReaper = vmBudget.register(budgetMember);

      // The first VM opens with the session, so a session that cannot create or harden a VM fails here (real-Modal F1).
      const first = addLane();
      await first.ensureSandbox().catch(async (error: unknown) => {
        closed = true;
        unregisterReaper();
        await first.terminate().catch(() => {});
        clientClosed = true;
        client.close();
        throw new SandboxInfrastructureError(`modal sandbox creation failed: ${safeMessage(config, error)}`, undefined, { cause: error });
      });

      let closing: Promise<void> | undefined;
      const session: SandboxSession = {
        providerId: "modal",
        isolation: ISOLATION,
        reportsStart: true,
        async run(command, signal, hooks) {
          // A closed session is the sandbox's failure, never the document's (recheck R #2).
          if (closed) throw new SandboxInfrastructureError("modal sandbox session is closed");
          if (signal?.aborted) throw new SandboxRunError("modal sandbox command aborted");
          // A scanner VM serves one organization: a command of any other, or one without an organization, is refused
          // before it can reach a VM. A command that needs the scanner daemon never runs on a plain parser VM.
          if (scanner && command.tenantKey !== scanner.tenantKey) {
            throw new SandboxPolicyError("scanner session refuses a command of another organization (or of none)");
          }
          // A scanner session serves one document (council M1): its first command binds it, and a command of any other
          // document, or of none, is refused before it can reach a VM that document's bytes may have touched.
          if (scanner) {
            if (!command.affinityKey) throw new SandboxPolicyError("scanner session refuses a command without a document");
            scannerDocument ??= command.affinityKey;
            if (command.affinityKey !== scannerDocument) throw new SandboxPolicyError("scanner session serves one document; refusing another document's command");
          }
          if (!scanner && command.requiresScanner) throw new SandboxPolicyError("this command needs a malware scanner session");
          let lane = await acquireLane(command.affinityKey, signal);
          if (hooks?.recordUsage) lane.recorder = hooks.recordUsage;
          try {
            // The worker VM token too, before admission: a command waiting for capacity is still queued, its time limit not
            // yet running, and an abort ends the wait (recheck T #2). If this activity's own VM goes idle meanwhile, the
            // command drops its empty lane and takes that VM over (real-Modal P2).
            for (;;) {
              try {
                await lane.reserve(signal);
                break;
              } catch (error) {
                if (!(error instanceof HandOver)) throw error;
                const idle = idleWithVm();
                if (!idle) continue;
                lane.dead = true;
                lanes.splice(lanes.indexOf(lane), 1);
                lane = idle;
                lane.busy = true;
                lane.previousKey = lane.lastKey;
                lane.lastKey = command.affinityKey;
                if (lane.previousKey !== command.affinityKey) lane.forgetUploads();
                if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = undefined; }
                if (hooks?.recordUsage) lane.recorder = hooks.recordUsage;
              }
            }
            // The VM is created and hardened before admission too (recheck S #4): its start-up never spends the command's
            // time limit, and a VM that cannot be created is the sandbox's failure.
            try {
              await lane.ensureSandbox();
            } catch (error) {
              throw new SandboxInfrastructureError(`modal sandbox creation failed: ${safeMessage(config, error)}`, undefined, { cause: error });
            }
            hooks?.onStart?.();
            // Metered as the VM's time since it was last metered (recheck R #3, VM pool follow-up): never this command's
            // wait for a VM, which is another command's time on it.
            return await lane.execute(command, Date.now(), signal);
          } finally {
            releaseLane(lane);
          }
        },
        async settle() {
          // The stage is done with the pool (VM pool follow-up): terminate idle VMs now, so their time after the last
          // command is recorded in the stage's ledger before its final checkpoint, and Modal stops billing them.
          // Awaited: the terminate is acknowledged and the time recorded before the checkpoint (recheck T #1).
          await Promise.all(lanes.filter((candidate) => !candidate.busy && !candidate.dead).map(reap));
        },
        close() {
          closing ??= (async () => {
            closed = true;
            unregisterReaper();
            while (waiting.length > 0) waiting.shift()!();
            const results = await Promise.allSettled(lanes.map((lane) => lane.terminate()));
            clientClosed = true;
            client.close();
            const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failed) throw failed.reason;
          })();
          return closing;
        },
      };
      return session;
    },
  };
  return provider;
}

export default createModalProvider(() => import("modal")) as unknown as ParserSandboxProvider;
