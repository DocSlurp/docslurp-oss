import type { ChildProcess } from "node:child_process";

export type SandboxNetworkIsolation = "none" | "tcp-only" | "full";

export interface SandboxIsolation {
  filesystem: boolean;
  network: SandboxNetworkIsolation;
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
  readablePaths: string[];
  writablePaths: string[];
  limits: SandboxLimits;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  peakRssKb?: number;
  cpuSeconds?: number;
}

export interface SandboxSession {
  readonly providerId: string;
  readonly isolation: SandboxIsolation;
  /** Local providers return a child process so the existing monitor keeps enforcing limits. */
  spawn?(command: SandboxCommand, signal?: AbortSignal): ChildProcess;
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
