/**
 * Worker supervision: keep the queue consumer alive through non-fatal failures.
 *
 * A Temporal worker stops for many reasons that say nothing about the machine
 * being unfit to run: the connection drops, a poller fails, the namespace is
 * briefly unreachable, Postgres blips. Exiting on all of them made every blip
 * depend on the platform restart policy (and Fly's `on-failure` policy gives up
 * after a retry limit). Instead the process recreates the connection and the
 * workers in place with exponential backoff and jitter, and exits non-zero only
 * for a FATAL state, which a restart cannot fix by itself or which leaves the
 * process unsafe to keep running.
 *
 * FATAL is defined here and nowhere else (`classifyWorkerFailure`):
 * - config:        invalid environment or worker options (startup validation,
 *                  TypeError/ValueError/RangeError from the Temporal SDK).
 * - auth:          Temporal rejected our credentials, TLS identity or namespace
 *                  (UNAUTHENTICATED, PERMISSION_DENIED, namespace not found,
 *                  certificate failures). Retrying cannot help.
 * - schema-behind: Postgres reports a missing table or column, i.e. migrations
 *                  have not been applied to this database.
 * - native-crash:  the Temporal core (Rust) panicked or reported an
 *                  unrecoverable internal error, or an uncaught exception that
 *                  is not a network blip; process state is untrusted.
 * - startup:       a precondition that must hold before polling (parser sandbox,
 *                  private model endpoints) failed.
 * Everything else is transient and retried forever. Fatal exits are logged as
 * `[worker-fatal] reason=<reason> ...` so the cause is greppable.
 */

import { causeChain, isTransientNetworkError } from "../lib/transient-errors.js";

export { isTransientNetworkError };

export type FatalWorkerReason = "config" | "auth" | "schema-behind" | "native-crash" | "startup";

export class FatalWorkerError extends Error {
  readonly reason: FatalWorkerReason;
  constructor(reason: FatalWorkerReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FatalWorkerError";
    this.reason = reason;
  }
}

export type WorkerFailureClass = { fatal: true; reason: FatalWorkerReason } | { fatal: false; reason: string };

const AUTH_PATTERN =
  /unauthenticated|permission[_ ]denied|namespace[^\n]*not[ _]found|namespace_not_found|invalid peer certificate|bad certificate|unknown ca|certificate (?:verify failed|has expired|is not valid)|unable to verify the first certificate|handshake failure/i;
const NATIVE_PANIC_PATTERN = /\bpanick?ed\b|\brust panic\b|core (?:has )?crashed|fatal runtime error/i;
const CONFIG_ERROR_NAMES = new Set(["TypeError", "ValueError", "RangeError", "ReferenceError", "SyntaxError"]);
/** Postgres undefined_table / undefined_column: the schema is older than the code. */
const SCHEMA_BEHIND_CODES = new Set(["42P01", "42703"]);

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The one place that decides whether a worker failure may be retried. */
export function classifyWorkerFailure(error: unknown): WorkerFailureClass {
  for (const link of causeChain(error)) {
    if (link instanceof FatalWorkerError) return { fatal: true, reason: link.reason };
    const name = link instanceof Error ? link.name : "";
    const message = describe(link);
    const code = typeof link === "object" && link !== null ? (link as { code?: unknown }).code : undefined;
    if (typeof code === "string" && SCHEMA_BEHIND_CODES.has(code)) return { fatal: true, reason: "schema-behind" };
    if (name === "UnexpectedError" || NATIVE_PANIC_PATTERN.test(message)) return { fatal: true, reason: "native-crash" };
    if (AUTH_PATTERN.test(message)) return { fatal: true, reason: "auth" };
    if (CONFIG_ERROR_NAMES.has(name) && !isTransientNetworkError(link)) return { fatal: true, reason: "config" };
  }
  return { fatal: false, reason: describe(error).split("\n")[0]!.slice(0, 300) };
}

/** Log the line operators grep for before a deliberate non-zero exit. */
export function logWorkerFatal(error: unknown, context: { phase: string }, log: (line: string) => void = console.error): void {
  const verdict = classifyWorkerFailure(error);
  const reason = verdict.fatal ? verdict.reason : "startup";
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`[worker-fatal] reason=${reason} phase=${context.phase} exiting=1 detail=${detail}`);
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** A session that ran at least this long resets the attempt counter. */
  stableAfterMs: number;
}

export const DEFAULT_RESTART_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 60_000, stableAfterMs: 60_000 };

/** Exponential backoff with jitter in [cap/2, cap]; attempt 1 is the first retry. */
export function restartDelayMs(attempt: number, options: BackoffOptions = DEFAULT_RESTART_BACKOFF, random: () => number = Math.random): number {
  const cap = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

export interface SupervisedSession {
  /** Resolves when every worker has stopped after shutdown(); rejects when one fails. */
  run(): Promise<void>;
  shutdown(): void;
  /** Release the connection. Must tolerate being called after a failure. */
  close(): Promise<void>;
}

export interface SuperviseOptions<S extends SupervisedSession> {
  /** Connect and create workers. Throwing here is classified like a run failure. */
  createSession: () => Promise<S>;
  /** Aborted when a stop is requested (SIGTERM, SIGINT, max runtime). */
  signal: AbortSignal;
  /** Reports the live session (or null while reconnecting) for health and metrics. */
  onSession?: (session: S | null) => void;
  /** Called for each retried failure. */
  onRestart?: (event: { attempt: number; delayMs: number; reason: string; error: unknown }) => void;
  backoff?: BackoffOptions;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (line: string) => void;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run workers until a stop is requested, recreating them after any non-fatal
 * failure. Resolves on a requested stop; throws only for fatal failures.
 */
export async function superviseTemporalWorkers<S extends SupervisedSession>(options: SuperviseOptions<S>): Promise<void> {
  const backoff = options.backoff ?? DEFAULT_RESTART_BACKOFF;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const { signal } = options;
  let attempt = 0;

  while (!signal.aborted) {
    let session: S | null = null;
    const startedAt = now();
    const onAbort = () => { try { session?.shutdown(); } catch { /* already stopping */ } };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      session = await options.createSession();
      if (signal.aborted) onAbort();
      options.onSession?.(session);
      await session.run();
      if (signal.aborted) return;
      throw new Error("Temporal worker run() returned without a shutdown request");
    } catch (error) {
      const verdict = classifyWorkerFailure(error);
      if (verdict.fatal) throw error instanceof FatalWorkerError ? error : new FatalWorkerError(verdict.reason, describe(error), { cause: error });
      if (signal.aborted) {
        log(`[temporal-worker] status=stopped-with-error reason=${verdict.reason}`);
        return;
      }
      if (now() - startedAt >= backoff.stableAfterMs) attempt = 0;
      attempt += 1;
      const delayMs = restartDelayMs(attempt, backoff, random);
      log(`[temporal-worker] status=restarting attempt=${attempt} delayMs=${delayMs} reason=${verdict.reason}`);
      options.onRestart?.({ attempt, delayMs, reason: verdict.reason, error });
      options.onSession?.(null);
      await session?.close().catch(() => undefined);
      session = null;
      await sleep(delayMs, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      options.onSession?.(null);
      await session?.close().catch(() => undefined);
    }
  }
}

/**
 * Run a group of workers: a failing worker stops its siblings, but the group
 * only settles once every worker has drained. The first failure is rethrown.
 */
export async function runWorkerGroup(workers: ReadonlyArray<{ run(): Promise<void>; shutdown(): void }>): Promise<void> {
  let failed = false;
  let firstError: unknown;
  const shutdownAll = () => {
    for (const worker of workers) {
      try { worker.shutdown(); } catch { /* already stopping */ }
    }
  };
  await Promise.allSettled(workers.map((worker) => Promise.resolve().then(() => worker.run()).catch((error) => {
    if (!failed) {
      failed = true;
      firstError = error;
    }
    shutdownAll();
    throw error;
  })));
  if (failed) throw firstError;
}

export interface ProcessGuardTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: "unhandledRejection" | "uncaughtException", listener: (...args: any[]) => void): unknown;
}

/**
 * Keep one stray promise or socket error from killing in-flight activities.
 * Unhandled rejections are logged and the process continues. An uncaught
 * exception is survivable only when it is a transient network error (a dropped
 * socket surfacing on an emitter nobody listens to); anything else leaves the
 * process in an unknown state, so it exits non-zero as fatal.
 */
export function installWorkerProcessGuards(options: {
  target?: ProcessGuardTarget;
  exit?: (code: number) => void;
  report?: (error: unknown, attributes: Record<string, string>) => void;
  log?: (line: string) => void;
} = {}): void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => { process.exitCode = code; setTimeout(() => process.exit(code), 2_000).unref(); });
  const report = options.report ?? (() => undefined);
  const log = options.log ?? ((line: string) => console.error(line));
  target.on("unhandledRejection", (reason) => {
    log(`[temporal-worker] unhandled rejection (continuing): ${describe(reason)}`);
    report(reason, { operation: "worker-unhandled-rejection" });
  });
  target.on("uncaughtException", (error) => {
    if (isTransientNetworkError(error)) {
      log(`[temporal-worker] uncaught transient network error (continuing): ${describe(error)}`);
      report(error, { operation: "worker-uncaught-transient" });
      return;
    }
    logWorkerFatal(new FatalWorkerError("native-crash", `uncaught exception: ${describe(error)}`, { cause: error }), { phase: "uncaught-exception" }, log);
    report(error, { operation: "worker-uncaught-fatal" });
    exit(1);
  });
}
