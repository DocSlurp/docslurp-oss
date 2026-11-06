import type { ChildProcess } from "node:child_process";

import type { UsageEvent } from "../models.js";

export type SandboxNetworkIsolation = "none" | "tcp-only" | "full";

export interface SandboxIsolation {
  filesystem: boolean;
  network: SandboxNetworkIsolation;
  /**
   * No process a command starts outlives it on the worker host, so teardown can be verified.
   * Local providers get it from a PID namespace; it covers what the command forks, not processes a
   * host service (a systemd user manager over the session bus) starts on its behalf outside the
   * namespace. Teardown fails closed on those: stdio still held past the bound poisons the slot.
   * Remote providers (modal) qualify because nothing runs on the host; a remote descendant can
   * outlive its command inside that activity's remote sandbox until the session ends.
   * Untrusted parser work refuses to run without it (see policy.ts and sandbox/teardown.ts).
   */
  processes: boolean;
  location: "local" | "remote";
}

export interface SandboxProbeResult {
  ok: boolean;
  isolation: SandboxIsolation;
  detail: string;
  /** A remote provider's tools, as the VM image reports them: command availability is decided from these, not the host PATH. */
  tools?: readonly string[];
}

export interface SandboxLimits {
  timeoutMs: number;
  rssBudgetMb?: number;
  cpu?: number;
}

export interface SandboxCommand {
  binary: string;
  args: string[];
  /** Already allowlisted by the runner. */
  env: NodeJS.ProcessEnv;
  /**
   * Host paths a local provider exposes read-only: the parser runtime (scripts, node_modules,
   * venv, interpreter) plus the command's inputs. Remote providers ignore it; their image
   * supplies the runtime.
   */
  readablePaths: string[];
  /** The command's file inputs inside DocSlurp temp workspaces. Remote providers upload exactly these. */
  inputPaths: string[];
  /** Directories the command may write. Remote providers create them and copy them back. */
  writablePaths: string[];
  limits: SandboxLimits;
  /**
   * Make creating a UNIX socket fail inside the sandbox (seccomp, sandbox/seccomp.ts). Only a session
   * with `filtersUnixSockets` may run such a command; the runner refuses it on any other.
   */
  denyUnixSockets?: boolean;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  peakRssKb?: number;
  cpuSeconds?: number;
  /** Provider cost of a remote run; the runner records it in the caller's usage scope. */
  usage?: UsageEvent;
}

/** A remote run that failed or was aborted, with the provider cost it incurred. */
export class SandboxRunError extends Error {
  constructor(
    message: string,
    readonly usage?: UsageEvent,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxRunError";
  }
}

/**
 * The sandbox, not the document, failed: a VM that could not be created or hardened, a leftover kill that did not
 * verify, a control deadline, a transport error. Infrastructure (lib/document-failure.ts): retried, never a verdict on
 * the document (real-Modal check F1). The runner notes it per document (session-context.ts), so a stage that catches it
 * and falls back still fails the activity instead of failing or degrading the document.
 */
export class SandboxInfrastructureError extends SandboxRunError {
  constructor(message: string, usage?: UsageEvent, options?: { cause?: unknown }) {
    super(message, usage, options);
    this.name = "SandboxInfrastructureError";
  }
}

export function findSandboxInfrastructureError(error: unknown): SandboxInfrastructureError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof Error && current.name === "SandboxInfrastructureError") return current as SandboxInfrastructureError;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export interface SandboxSession {
  readonly providerId: string;
  readonly isolation: SandboxIsolation;
  /**
   * The session keeps a command from meeting another (or a host service) on a UNIX socket:
   * bubblewrap with its seccomp filter (`SandboxCommand.denyUnixSockets`), landlock with landrun's
   * scoping (abstract and pathname connects outside the command's domain are refused). Without it
   * the runner refuses those commands unless DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS opts in
   * (development only).
   */
  readonly filtersUnixSockets?: boolean;
  /**
   * Local providers return a child started by `spawnContained` (sandbox/teardown.ts); the runner
   * refuses any other. The caller owns abort, limits and teardown through `superviseChild`.
   */
  spawn?(command: SandboxCommand): ChildProcess;
  /** Remote providers run to completion and enforce limits provider-side. */
  run?(command: SandboxCommand, signal?: AbortSignal): Promise<SandboxResult>;
  close(): Promise<void>;
}

export interface SandboxConfigProperty {
  type: "string" | "number" | "boolean";
  description: string;
  default?: string | number | boolean;
  secret?: boolean;
  /** Environment variable this property is read from. */
  env: string;
}

export interface SandboxConfigSchema {
  type: "object";
  properties: Record<string, SandboxConfigProperty>;
  required?: string[];
}

export interface ParserSandboxProvider<C = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  configSchema: SandboxConfigSchema;
  readConfig(env: NodeJS.ProcessEnv): C;
  probe(config: C): Promise<SandboxProbeResult>;
  /**
   * `unmetered`: the session's VM time is never recorded (the startup probe), so it is not priced; pricing may not be
   * loaded yet, and under the service profile pricing() refuses until it is.
   */
  openSession(config: C, context: { activityId: string; unmetered?: boolean }): Promise<SandboxSession>;
}

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}
