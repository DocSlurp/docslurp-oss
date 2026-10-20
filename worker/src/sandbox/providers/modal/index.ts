import { readFileSync } from "node:fs";

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
import { SessionStaging, type RemoteFs } from "./staging.js";

export type ModalSdk = typeof import("modal");

export interface ModalConfig {
  tokenId: string;
  tokenSecret: string;
  app: string;
  image: string;
  cpu: number;
  memoryMb: number;
  sessionTimeoutSeconds: number;
}

const ISOLATION: SandboxIsolation = { filesystem: true, network: "full", processes: true, location: "remote" };

function workerVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

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
      description: "Container image sandboxes run, which must contain the parser binaries.",
      default: `ghcr.io/docslurp/worker-full:${workerVersion()}`,
      env: "DOCSLURP_MODAL_IMAGE",
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

function buildRemoteFs(sdk: ModalSdk, fs: import("modal").SandboxFilesystem): RemoteFs {
  return {
    async exists(p) {
      try {
        await fs.stat(p);
        return true;
      } catch (error) {
        if (error instanceof sdk.SandboxFilesystemNotFoundError) return false;
        throw error;
      }
    },
    writeFile: (p, data) => fs.writeBytes(data, p),
    readFile: (p) => fs.readBytes(p),
    async list(p) {
      const entries = await fs.listFiles(p);
      return entries
        .filter((entry) => entry.type !== "symlink")
        .map((entry) => ({ path: entry.path, isDir: entry.type === "directory" }));
    },
    mkdir: (p) => fs.makeDirectory(p),
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
    readConfig: (env) => readSandboxConfig<ModalConfig>(configSchema, env),
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
          const image = client.images.fromRegistry(config.image);
          sandbox = await client.sandboxes.create(app, image, {
            cpu: config.cpu,
            memoryMiB: config.memoryMb,
            timeoutMs: config.sessionTimeoutSeconds * 1000,
            blockNetwork: true,
          });
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

      async function execute(command: SandboxCommand, started: number, signal?: AbortSignal): Promise<SandboxResult> {
        try {
          await ensureSandbox();
          // Only the command's inputs travel; the parser runtime comes from the image.
          await staging!.ensureUploaded(command.inputPaths);
          for (const dir of command.writablePaths) await sandbox!.filesystem.makeDirectory(dir);
          const env: Record<string, string> = {};
          for (const [key, value] of Object.entries(command.env)) if (value !== undefined) env[key] = value;
          let output: { stdout: string; stderr: string; exitCode: number | null };
          try {
            const process = await sandbox!.exec([command.binary, ...command.args], {
              env,
              timeoutMs: command.limits.timeoutMs,
              mode: "text",
            });
            const [stdout, stderr, exitCode] = await Promise.all([
              process.stdout.readText(),
              process.stderr.readText(),
              process.wait(),
            ]);
            output = { stdout, stderr, exitCode };
          } catch (error) {
            // Modal enforces the exec timeout provider-side; report it like a killed process
            // (null exit code). Every other failure is a provider error and propagates.
            if (!isExecTimeout(sdk, error)) throw error;
            output = { stdout: "", stderr: "command exceeded its time limit", exitCode: null };
          }
          // An aborted command's caller has moved on; never write its outputs back.
          if (!signal?.aborted) await staging!.download(command.writablePaths);
          const usage = meter(started);
          return { ...output, cpuSeconds: config.cpu * ((Date.now() - started) / 1000), usage };
        } catch (error) {
          // Elapsed Modal time is billed even when staging or exec failed.
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
          const started = Date.now();
          const execution = execute(command, started, signal);
          if (!signal) return await execution;
          // An abort ends this command only: other commands in the activity share the sandbox,
          // which only close() terminates. The SDK cannot kill a single exec, so the caller
          // stops waiting now and the exec runs on until its own timeoutMs; its result and
          // outputs are discarded. Usage is recorded up to the abort; the [sandbox-usage]
          // line is logged when the exec ends.
          let onAbort!: () => void;
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () =>
              reject(
                new SandboxRunError(
                  "modal sandbox command aborted",
                  buildModalUsageEvent(config, context.activityId, (Date.now() - started) / 1000),
                ),
              );
          });
          signal.addEventListener("abort", onAbort, { once: true });
          execution.catch(() => {});
          try {
            return await Promise.race([execution, aborted]);
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
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
