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
  ) {
    super(message);
    this.name = "SandboxRunError";
  }
}

export interface SandboxSession {
  readonly providerId: string;
  readonly isolation: SandboxIsolation;
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
  openSession(config: C, context: { activityId: string }): Promise<SandboxSession>;
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
