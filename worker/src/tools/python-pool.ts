import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import { buildAllowlistedEnv, defaultPythonPoolEnvAllowlist } from "./process-env.js";

interface PythonRequest {
  id: string;
  args: unknown;
}

interface PythonResponse {
  id: string;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  abortCleanup?: () => void;
}

interface Worker {
  id: number;
  process: ChildProcess;
  readline: ReadlineInterface;
  busy: boolean;
  pending: Map<string, PendingRequest>;
  stderr: string;
}

interface PythonPoolOptions {
  binary?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export class PythonPool {
  private readonly workers: Worker[] = [];
  private readonly waitQueue: Array<{
    resolve: (workerId: number) => void;
  }> = [];
  private closed = false;
  private readonly binary: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly scriptPath: string,
    private readonly maxWorkers: number,
    options: PythonPoolOptions = {}
  ) {
    this.binary = options.binary ?? "python3";
    this.args = options.args ?? [];
    this.env = options.env ?? buildAllowlistedEnv({
      defaultAllowlist: defaultPythonPoolEnvAllowlist,
      allowlistEnvVar: "DOCSLURP_PYTHON_POOL_ENV_ALLOWLIST"
    });
    for (let i = 0; i < maxWorkers; i++) {
      this.workers.push(this.spawnWorker(i));
    }
  }

  private spawnWorker(id: number): Worker {
    const proc = spawn(this.binary, [this.scriptPath, ...this.args], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const readline = createInterface({ input: proc.stdout! });
    const worker: Worker = {
      id,
      process: proc,
      readline,
      busy: false,
      pending: new Map(),
      stderr: "",
    };

    proc.stderr?.on("data", (chunk) => {
      worker.stderr = `${worker.stderr}${chunk.toString()}`.slice(-4000);
    });

    readline.on("line", (line) => {
      try {
        const response = JSON.parse(line) as PythonResponse;
        const req = worker.pending.get(response.id);
        if (!req) return;
        worker.pending.delete(response.id);
        if (response.error) {
          req.reject(new Error(response.error));
        } else {
          req.resolve(response.result);
        }
      } catch {
        // ignore malformed lines
      }
    });

    proc.on("exit", () => {
      const message = worker.stderr.trim();
      for (const req of worker.pending.values()) {
        req.reject(new Error(message ? `python worker exited unexpectedly: ${message}` : "python worker exited unexpectedly"));
        req.abortCleanup?.();
      }
      worker.pending.clear();

      if (!this.closed) {
        this.workers[id] = this.spawnWorker(id);
        this.flushWaitQueue();
      }
    });

    return worker;
  }

  acquire(): Promise<number> {
    const idle = this.workers.find((w) => !w.busy && w.process.exitCode === null);
    if (idle) {
      idle.busy = true;
      return Promise.resolve(idle.id);
    }
    return new Promise((resolve) => {
      this.waitQueue.push({ resolve });
    });
  }

  private flushWaitQueue(): void {
    while (this.waitQueue.length > 0) {
      const idle = this.workers.find((candidate) => !candidate.busy && candidate.process.exitCode === null);
      if (!idle) {
        return;
      }
      idle.busy = true;
      const next = this.waitQueue.shift();
      next?.resolve(idle.id);
    }
  }

  release(workerId: number): void {
    const worker = this.workers[workerId];
    if (!worker) return;
    worker.busy = false;
    this.flushWaitQueue();
  }

  async send<T>(workerId: number, args: unknown, signal?: AbortSignal): Promise<T> {
    const worker = this.workers[workerId];
    if (!worker || worker.process.exitCode !== null) {
      throw new Error(`python worker ${workerId} is not available`);
    }

    const id = randomUUID();
    const request: PythonRequest = { id, args };

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        worker.pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      const pending: PendingRequest = {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
        abortCleanup: () => signal?.removeEventListener("abort", onAbort)
      };

      worker.pending.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.process.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const worker of this.workers) {
      worker.readline.close();
      worker.process.kill();
    }
  }
}

export function createPool(scriptPath: string, maxWorkers: number, options?: PythonPoolOptions): PythonPool {
  return new PythonPool(scriptPath, maxWorkers, options);
}
