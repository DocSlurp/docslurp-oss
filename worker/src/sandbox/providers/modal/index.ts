import { randomUUID } from "node:crypto";
import { pricing } from "@docslurp/shared";

import { boundedVmStream } from "./transfer.js";
import path from "node:path";
import { resolveWorkerDeploymentProfile, buildLocalComputeUsageEvent } from "../../../pipeline/local-compute-cost.js";
import type { UsageEvent } from "../../../models.js";
import { readSandboxConfig } from "../../config-schema.js";
import {
  SandboxConfigError,
  SandboxInfrastructureError,
  SandboxRunError,
  type ParserSandboxProvider,
  type SandboxCommand,
  type SandboxConfigSchema,
  type SandboxIsolation,
  type SandboxResult,
  type SandboxSession,
} from "../../types.js";
import { asParserUser, CONTROL_DIR, HARDEN_LINKS_ARGV, KILL_PARSER_USER_ARGV, killArgv, launchArgv } from "./control.js";
import { SessionStaging, type RemoteEntry, type RemoteFs, type RemoteSnapshot } from "./staging.js";
import { vmOnlyParsing } from "../../../lib/vm-only-parsing.js";

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
/** Lifetime of the startup probe's VM: a backstop if its terminate request is lost. */
export const PROBE_SESSION_TIMEOUT_SECONDS = 120;
/** Deadline for the terminate request. Modal stops the VM once it accepts the request; exit is not awaited. */
const TERMINATE_REQUEST_MS = 10_000;

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
        await runChecked(sandbox, [...asParserUser(), "/bin/sh", "-c", 'mkdir -p -- "$(dirname -- "$2")" && cp -- "$1" "$2"', "sh", staged, p], "parser VM upload failed");
      } finally {
        await fs.remove(staged).catch(() => {});
      }
    },
    async readFile(p) {
      // Read as the parser user: root never follows a link the job left in its own output (council K #5).
      const proc = await sandbox.exec([...asParserUser(), "/bin/cat", "--", p], { mode: "binary", timeoutMs: 30_000 });
      const [data, , code] = await Promise.all([boundedVmStream(proc.stdout, 128 * 1024 * 1024), boundedVmStream(proc.stderr, 64 * 1024), proc.wait()]);
      if (code !== 0) throw new Error("parser VM file transfer failed");
      return data;
    },
    async list(p) {
      // Do not ask the SDK to allocate an unbounded directory listing from the guest.
      const code = "import os,sys,json\np=sys.argv[1]\nwith os.scandir(p) as entries:\n for i,e in enumerate(entries):\n  if i>=8192: raise RuntimeError('directory entry limit')\n  if e.is_symlink(): continue\n  st=e.stat(follow_symlinks=False)\n  print(json.dumps(dict(path=e.path,isDir=e.is_dir(follow_symlinks=False),size=st.st_size,mtime=st.st_mtime)))";
      const proc = await sandbox.exec([...asParserUser(), "python3", "-I", "-c", code, p], { mode: "binary", timeoutMs: 30_000 });
      const [data, , status] = await Promise.all([boundedVmStream(proc.stdout, 4 * 1024 * 1024), boundedVmStream(proc.stderr, 64 * 1024), proc.wait()]);
      if (status !== 0) throw new Error("parser VM directory listing failed");
      return data.toString("utf8").split("\n").filter(Boolean).map((line) => {
        const entry = JSON.parse(line) as RemoteEntry;
        if (typeof entry.path !== "string" || path.dirname(entry.path) !== p || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.isDir !== "boolean" || !Number.isFinite(entry.mtime)) throw new Error("invalid parser VM directory entry");
        return entry;
      });
    },
    mkdir: (p) => runChecked(sandbox, [...asParserUser(), "/bin/mkdir", "-p", "--", p], "parser VM directory creation failed"),
    remove: (p) => runChecked(sandbox, [...asParserUser(), "/bin/rm", "-rf", "--", p], "parser VM removal failed"),
  };
}

/**
 * Provider cost of one command as a usage event. The SDK reports no cpu/memory consumption
 * for a sandbox, so usage is the requested cpu x wall seconds and requested memory GiB x wall
 * seconds (what Modal bills for, at max(request, usage)). It is priced at the pricing provider's sandbox
 * rates (`internalCost.sandboxCostCents`; 0 under the open default), not the worker host's, and the
 * cost rides as `providerCostCents` so the provider-cost loss alert sees it. It is provider cost only:
 * `costRollup: "included"` and `billable: false` keep it out of customer credits.
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
      return { ...config, image };
    },
    async probe(config) {
      let session: SandboxSession | undefined;
      try {
        session = await provider.openSession({ ...config, sessionTimeoutSeconds: Math.min(config.sessionTimeoutSeconds, PROBE_SESSION_TIMEOUT_SECONDS) }, { activityId: "startup-probe", unmetered: true });
        const result = await session.run!({ binary: "node", args: ["/app/worker/scripts/parser-vm-contract.mjs"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, readablePaths: [], inputPaths: [], writablePaths: [], limits: { timeoutMs: 30_000 } });
        const contract = result.exitCode === 0 ? JSON.parse(result.stdout) as { protocol?: unknown; uid?: unknown; tools?: unknown; links?: { hardlinks?: unknown; symlinks?: unknown } } : null;
        if (contract?.protocol !== "parser-vm@2") throw new Error("parser VM image contract unavailable");
        // Parser commands drop root in the VM (control.ts); a contract run as root means they would parse as root (N10).
        if (typeof contract.uid !== "number" || contract.uid === 0) throw new Error("parser VM commands do not drop root privileges");
        // Kernel link protections (council K #5, N #2): both must be reported exactly 1; off, absent, null or malformed fails.
        if (contract.links?.hardlinks !== 1 || contract.links?.symlinks !== 1) {
          throw new Error(`parser VM kernel link protections are not confirmed on (hardlinks=${JSON.stringify(contract.links?.hardlinks ?? null)}, symlinks=${JSON.stringify(contract.links?.symlinks ?? null)})`);
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
      const { sdk, client } = await loadClient(config);
      let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;
      let staging: SessionStaging | undefined;
      let creating: Promise<void> | undefined;
      let closed = false;
      let clientClosed = false;

      let terminating: Promise<void> | undefined;
      function terminate(): Promise<void> {
        closed = true;
        terminating ??= doTerminate();
        return terminating;
      }
      async function doTerminate(): Promise<void> {
        let failure: unknown;
        try {
          // Ask Modal to stop the VM; waiting for its exit is not needed (and an image process that ignores signals could
          // hold a wait for tens of seconds).
          if (sandbox) await withDeadline(sandbox.terminate(), TERMINATE_REQUEST_MS);
        } catch (error) {
          failure = error;
        } finally {
          clientClosed = true;
          client.close();
        }
        if (failure !== undefined && sandbox) {
          // Retry once on a fresh client so a stuck connection cannot leave the VM running.
          if (await terminateLate(sandbox)) return;
          throw new Error(`modal sandbox terminate failed: ${safeMessage(config, failure)}`);
        }
      }
      async function terminateLate(created: import("modal").Sandbox): Promise<boolean> {
        const cleanupClient = clientClosed ? new sdk.ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret }) : client;
        try { await withDeadline(new sdk.Sandbox(cleanupClient, created.sandboxId).terminate(), TERMINATE_REQUEST_MS); return true; }
        catch { console.warn("[parser-sandbox] late VM cleanup failed; provider lifetime limit remains enforced"); return false; }
        finally { if (cleanupClient !== client) cleanupClient.close(); }
      }

      function ensureSandbox(): Promise<void> {
        creating ??= (async () => {
          const app = await withDeadline(client.apps.fromName(config.app, { createIfMissing: true }), 30_000);
          const registrySecret = config.registrySecret && !config.imageId ? await withDeadline(client.secrets.fromName(config.registrySecret), 30_000) : undefined;
          const image = config.imageId ? await withDeadline(client.images.fromId(config.imageId), 30_000) : client.images.fromRegistry(config.image, registrySecret);
          const opened = await withDeadline(client.sandboxes.create(app, image, {
            runtime: "vm",
            command: [...PARSER_VM_IDLE_COMMAND],
            includeOidcIdentityToken: false,
            env: {}, secrets: [], volumes: {}, cloudBucketMounts: {},
            cpu: config.cpu, cpuLimit: config.cpu,
            memoryMiB: config.memoryMb, memoryLimitMiB: config.memoryMb,
            timeoutMs: config.sessionTimeoutSeconds * 1000,
            blockNetwork: true,
          }).then(async (created) => {
            if (closed) { await terminateLate(created); throw new Error("parser VM session closed during creation"); }
            return created;
          }), 30_000);
          if (!opened) throw new Error("parser VM creation returned no sandbox");
          sandbox = opened;
          // As root, once: kernel link protections on and read back as 1, or this VM runs nothing (council K #5, Modal check).
          const hardened = await withDeadline(opened.exec(HARDEN_LINKS_ARGV, { timeoutMs: 10_000 }).then((proc) => proc.wait()), 15_000);
          if (hardened !== 0) throw new Error("parser VM kernel link protections could not be turned on");
          await withDeadline(opened.filesystem.makeDirectory(CONTROL_DIR), 30_000);
          // Root-owned and not writable by the parser user; uploads staged here are copied into place as uid 10001.
          await withDeadline(runChecked(opened, ["/bin/chmod", "0711", "--", CONTROL_DIR], "parser VM control directory setup failed"), 30_000);
          staging = new SessionStaging(buildRemoteFs(sdk, opened));
        })();
        return creating;
      }

      /** Log the command's Modal time and return it as a provider-cost usage event (none for an unmetered session). */
      function meter(started: number): UsageEvent | undefined {
        const wallSeconds = (Date.now() - started) / 1000;
        console.log(
          `[sandbox-usage] provider=modal cpu_seconds=${(config.cpu * wallSeconds).toFixed(3)} memory_gb_seconds=${((config.memoryMb / 1024) * wallSeconds).toFixed(3)} activity=${context.activityId}`,
        );
        if (context.unmetered) return undefined;
        return buildModalUsageEvent(config, context.activityId, wallSeconds);
      }

      /**
       * Kill a command's remote process group, then wait (bounded) for its exec to end. Best
       * effort: a sandbox that is already gone has nothing left to kill.
       *
       * The caller settles (and releases its local slot) after this, even if a remote descendant
       * that started its own session survived the group kill. That is safe for the worker host:
       * the survivor runs only inside this activity's Modal sandbox, cannot reach local scratch,
       * and ends when the session closes or sessionTimeoutSeconds expires. What it can still do is
       * burn remote CPU and write into this session's remote working directories.
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
          settled = Promise.all([boundedVmStream(process.stdout, 8 * 1024 * 1024).then((bytes) => bytes.toString("utf8")), boundedVmStream(process.stderr, 1024 * 1024).then((bytes) => bytes.toString("utf8")), process.wait()]).then(
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

      /**
       * Changes left by aborted and timed-out commands, removed once no command is in flight:
       * a command still running may be writing into the same directories, and its files
       * cannot be told apart from the abandoned command's until it has finished and claimed them.
       */
      const pendingDiscards: RemoteSnapshot[] = [];
      let inFlight = 0;
      let discarding: Promise<void> | undefined;

      async function runDiscards(): Promise<void> {
        try {
          // A closed session's sandbox is gone, and its changes with it.
          while (pendingDiscards.length > 0 && !closed) {
            try {
              await staging!.discard(pendingDiscards.shift()!);
            } catch (error) {
              console.warn(`[parser-sandbox] provider=modal discard failed: ${safeMessage(config, error)}`);
            }
          }
        } finally {
          discarding = undefined;
        }
      }

      /**
       * Kill every process the parser user still runs (council M #3): a daemon a command left behind could otherwise act
       * between commands. Only when no other command is in flight, since they share the user. Best effort: an empty VM
       * has nothing to kill.
       */
      async function killParserUserProcesses(): Promise<void> {
        // As root, so it needs no fork as the parser user (RLIMIT_NPROC cannot stop it), and verified: a parser-user process
        // left alive fails the session closed (council O #4).
        let code: number | null = null;
        try {
          const proc = await sandbox!.exec(KILL_PARSER_USER_ARGV, { timeoutMs: KILL_SETTLE_MS * 3 });
          code = await proc.wait();
        } catch (error) {
          console.error(`[parser-sandbox] provider=modal leftover kill failed: ${safeMessage(config, error)}`);
        }
        if (code !== 0) {
          await terminate().catch(() => {});
          throw new SandboxInfrastructureError("parser VM leftover processes could not be killed; session closed");
        }
      }

      /**
       * The leftover kill as a barrier (council P #3): claimed in the same synchronous step that sees no other command in
       * flight, and admission waits for it, so no command stages or starts while the parser user's processes are killed.
       */
      let cleaning: Promise<void> | undefined;
      function cleanLeftovers(): Promise<void> {
        cleaning ??= killParserUserProcesses().finally(() => { cleaning = undefined; });
        return cleaning;
      }

      /**
       * One command at a time per session (council O #4): staging, the run, the leftover kill and the download never
       * overlap another command's, so a user-wide kill can never hit a command that is starting or running.
       */
      let sessionQueue: Promise<unknown> = Promise.resolve();
      function execute(command: SandboxCommand, started: number, signal?: AbortSignal): Promise<SandboxResult> {
        const turn = sessionQueue.then(() => executeExclusive(command, started, signal));
        sessionQueue = turn.catch(() => {});
        return turn;
      }

      /** Whether the running command already killed the parser user's leftovers (before its download). */
      let cleanedAfterRun = false;

      async function executeExclusive(command: SandboxCommand, started: number, signal?: AbortSignal): Promise<SandboxResult> {
        // A command queued behind one that closed the session never starts.
        if (closed) throw new SandboxInfrastructureError("modal sandbox session is closed");
        while (discarding || cleaning) await (discarding ?? cleaning);
        cleanedAfterRun = false;
        inFlight++;
        try {
          try { return await withDeadline(executeCommand(command, started, signal), command.limits.timeoutMs + 60_000); }
          catch (error) {
            if (error instanceof Error && error.message === "parser VM control deadline exceeded") {
              await terminate().catch(() => {});
              throw new SandboxInfrastructureError(error.message, meter(started), { cause: error });
            }
            throw error;
          }
        } finally {
          inFlight--;
          if (inFlight === 0 && sandbox && !closed && !cleanedAfterRun) await cleanLeftovers();
          if (inFlight === 0 && pendingDiscards.length > 0 && !closed) {
            discarding ??= runDiscards();
            await discarding;
          }
        }
      }

      let commandCount = 0;

      async function executeCommand(command: SandboxCommand, started: number, signal?: AbortSignal): Promise<SandboxResult> {
        const control = `${CONTROL_DIR}/${++commandCount}`;
        try {
          await ensureSandbox();
          throwIfAborted(signal);
          // Only the command's inputs travel; the parser runtime comes from the image.
          await staging!.ensureUploaded(command.inputPaths);
          throwIfAborted(signal);
          await staging!.ensureDirectories(command.writablePaths);
          throwIfAborted(signal);
          const snapshot = await staging!.snapshot(command.writablePaths);
          throwIfAborted(signal);
          let outcome: RemoteOutcome;
          try {
            outcome = await runRemote(command, control, signal);
          } catch (error) {
            pendingDiscards.push(snapshot);
            throw error;
          }
          if (outcome.kind === "exited" && !signal?.aborted) {
            // Leftover processes die before anything is read back or staged (council M #3), when this is the only command.
            if (inFlight === 1) { await cleanLeftovers(); cleanedAfterRun = true; }
            // Only what this command created or changed comes back.
            if (closed) throw new Error("parser VM session closed before download");
            await staging!.download(snapshot);
            const usage = meter(started);
            return { ...outcome.output, cpuSeconds: config.cpu * ((Date.now() - started) / 1000), usage };
          }
          // Aborted or timed out: its outputs may be partial. Never download them, and remove
          // them remotely so no later command's download copies them back.
          pendingDiscards.push(snapshot);
          if (outcome.kind !== "timeout") throw new CommandAborted();
          const usage = meter(started);
          return {
            stdout: "",
            stderr: "command exceeded its time limit",
            exitCode: null,
            cpuSeconds: config.cpu * ((Date.now() - started) / 1000),
            usage,
          };
        } catch (error) {
          // Elapsed Modal time is billed even when staging or exec failed.
          if (error instanceof CommandAborted) throw new SandboxRunError("modal sandbox command aborted", meter(started));
          // Anything else that throws here is the sandbox's (a document's own failure is a non-zero exit, not a throw).
          throw new SandboxInfrastructureError(`modal sandbox command failed: ${safeMessage(config, error)}`, meter(started), { cause: error });
        }
      }

      await ensureSandbox().catch(async (error: unknown) => {
        await terminate().catch(() => {});
        throw new SandboxInfrastructureError(`modal sandbox creation failed: ${safeMessage(config, error)}`, undefined, { cause: error });
      });

      const session: SandboxSession = {
        providerId: "modal",
        isolation: ISOLATION,
        async run(command, signal) {
          if (closed) throw new Error("modal sandbox session is closed");
          if (signal?.aborted) throw new SandboxRunError("modal sandbox command aborted");
          // An abort ends this command only: other commands in the activity share the sandbox,
          // which only close() terminates. The command's process group is killed and its
          // partial outputs removed before the abort is reported.
          return execute(command, Date.now(), signal);
        },
        async close() {
          await terminate();
        },
      };
      return session;
    },
  };
  return provider;
}

export default createModalProvider(() => import("modal")) as unknown as ParserSandboxProvider;
