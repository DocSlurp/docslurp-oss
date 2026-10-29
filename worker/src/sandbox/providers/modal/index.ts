import { resolveWorkerDeploymentProfile, buildLocalComputeUsageEvent } from "../../../pipeline/local-compute-cost.js";
import type { UsageEvent } from "../../../models.js";
import { readSandboxConfig } from "../../config-schema.js";
import {
  SandboxConfigError,
  SandboxRunError,
  type ParserSandboxProvider,
  type SandboxCommand,
  type SandboxConfigSchema,
  type SandboxIsolation,
  type SandboxResult,
  type SandboxSession,
} from "../../types.js";
import { CONTROL_DIR, killArgv, launchArgv } from "./control.js";
import { SessionStaging, type RemoteEntry, type RemoteFs, type RemoteSnapshot } from "./staging.js";

export type ModalSdk = typeof import("modal");

export interface ModalConfig {
  tokenId: string;
  tokenSecret: string;
  app: string;
  /** Image reference sandboxes run; `repo@sha256:<digest>` when a digest is configured. */
  image: string;
  /** Name of a Modal Secret with REGISTRY_USERNAME/REGISTRY_PASSWORD for a private image. */
  registrySecret?: string;
  cpu: number;
  memoryMb: number;
  sessionTimeoutSeconds: number;
}

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

function buildRemoteFs(sdk: ModalSdk, fs: import("modal").SandboxFilesystem): RemoteFs {
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
    writeFile: (p, data) => fs.writeBytes(data, p),
    readFile: (p) => fs.readBytes(p),
    async list(p) {
      const entries = await fs.listFiles(p);
      return entries.filter((entry) => entry.type !== "symlink").map(toRemoteEntry);
    },
    mkdir: (p) => fs.makeDirectory(p),
    remove: (p) => fs.remove(p, { recursive: true }),
  };
}

/**
 * Provider cost of one command as a usage event. The SDK reports no cpu/memory consumption
 * for a sandbox, so usage is the requested cpu x wall seconds and requested memory GB x wall
 * seconds (what Modal bills for). It is provider cost only: `costRollup: "included"` and
 * `billable: false` keep it out of customer credits, which the stage's own compute event covers.
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
  return { ...event, provider: "modal" };
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

  return {
    id: "modal",
    name: "Modal",
    description: "Runs each parser in a remote Modal sandbox with files staged in and out per activity.",
    configSchema,
    readConfig: (env) => {
      const { imageDigest, ...config } = readSandboxConfig<
        Omit<ModalConfig, "image"> & { image?: string; imageDigest?: string }
      >(configSchema, env);
      return { ...config, image: resolveModalImage(config.image ?? defaultModalImage(env), imageDigest) };
    },
    async probe(config) {
      let client: Awaited<ReturnType<typeof loadClient>>["client"] | undefined;
      try {
        client = (await loadClient(config)).client;
        await client.apps.fromName(config.app, { createIfMissing: true });
        return { ok: true, isolation: ISOLATION, detail: `modal app '${config.app}' reachable` };
      } catch (error) {
        return { ok: false, isolation: ISOLATION, detail: safeMessage(config, error) };
      } finally {
        client?.close();
      }
    },
    async openSession(config, context) {
      const { sdk, client } = await loadClient(config);
      let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>> | undefined;
      let staging: SessionStaging | undefined;
      let creating: Promise<void> | undefined;
      let closed = false;

      let terminating: Promise<void> | undefined;
      function terminate(): Promise<void> {
        closed = true;
        terminating ??= doTerminate();
        return terminating;
      }
      async function doTerminate(): Promise<void> {
        try {
          await creating?.catch(() => {});
          await sandbox?.terminate();
        } catch (error) {
          throw new Error(`modal sandbox terminate failed: ${safeMessage(config, error)}`);
        } finally {
          client.close();
        }
      }

      function ensureSandbox(): Promise<void> {
        creating ??= (async () => {
          const app = await client.apps.fromName(config.app, { createIfMissing: true });
          const registrySecret = config.registrySecret ? await client.secrets.fromName(config.registrySecret) : undefined;
          const image = client.images.fromRegistry(config.image, registrySecret);
          sandbox = await client.sandboxes.create(app, image, {
            cpu: config.cpu,
            memoryMiB: config.memoryMb,
            timeoutMs: config.sessionTimeoutSeconds * 1000,
            blockNetwork: true,
          });
          await sandbox.filesystem.makeDirectory(CONTROL_DIR);
          staging = new SessionStaging(buildRemoteFs(sdk, sandbox.filesystem));
        })();
        return creating;
      }

      /** Log the command's Modal time and return it as a provider-cost usage event. */
      function meter(started: number): UsageEvent {
        const wallSeconds = (Date.now() - started) / 1000;
        console.log(
          `[sandbox-usage] provider=modal cpu_seconds=${(config.cpu * wallSeconds).toFixed(3)} memory_gb_seconds=${((config.memoryMb / 1024) * wallSeconds).toFixed(3)} activity=${context.activityId}`,
        );
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
        const argv = launchArgv(control, command.binary, command.args);
        let settled: Promise<{ stdout: string; stderr: string; exitCode: number | null }> = Promise.reject(
          new Error("exec did not start"),
        );
        settled.catch(() => {});
        const aborted = whenAborted(signal);
        try {
          const process = await sandbox!.exec(argv, { env, timeoutMs: execTimeoutMs(command.limits.timeoutMs), mode: "text" });
          settled = Promise.all([process.stdout.readText(), process.stderr.readText(), process.wait()]).then(
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

      async function execute(command: SandboxCommand, started: number, signal?: AbortSignal): Promise<SandboxResult> {
        while (discarding) await discarding;
        inFlight++;
        try {
          return await executeCommand(command, started, signal);
        } finally {
          inFlight--;
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
            // Only what this command created or changed comes back.
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
          throw new SandboxRunError(`modal sandbox command failed: ${safeMessage(config, error)}`, meter(started));
        }
      }

      await ensureSandbox().catch(async (error: unknown) => {
        await terminate().catch(() => {});
        throw new Error(`modal sandbox creation failed: ${safeMessage(config, error)}`);
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
}

export default createModalProvider(() => import("modal")) as unknown as ParserSandboxProvider;
