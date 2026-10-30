import { AsyncLocalStorage } from "node:async_hooks";

import type { SandboxSession } from "./types.js";

/**
 * One sandbox session per scope (one Temporal activity). The session opens
 * lazily on first use so activities that never run a parser cost nothing.
 */
export class SandboxSessionScope {
  private opening: Promise<SandboxSession> | null = null;
  private latched: Error | null = null;

  constructor(private readonly open: () => Promise<SandboxSession>) {}

  get(): Promise<SandboxSession> {
    this.opening ??= this.open();
    return this.opening;
  }

  /**
   * The first command teardown in this scope that could not be verified (a CommandTeardownError).
   * Once set, the activity ends as a non-retryable teardown failure whatever else happens: a stage
   * that swallowed the error (a parser fallback), a watchdog that replaced it, a cancellation or a
   * shutdown cannot turn it into a retry on another worker.
   */
  get teardownError(): Error | null {
    return this.latched;
  }

  latchTeardown(error: Error): void {
    this.latched ??= error;
  }

  async close(): Promise<void> {
    if (!this.opening) return;
    const opening = this.opening;
    let session: SandboxSession;
    try {
      session = await opening;
    } catch {
      return; // never opened; nothing to release
    }
    await session.close();
  }
}

export const sandboxScopeStorage = new AsyncLocalStorage<SandboxSessionScope>();

/** The current activity's latched teardown failure, if any (see SandboxSessionScope.teardownError). */
export function latchedTeardownError(): Error | null {
  return sandboxScopeStorage.getStore()?.teardownError ?? null;
}

export function runWithSandboxScope<T>(scope: SandboxSessionScope, fn: () => Promise<T>): Promise<T> {
  return sandboxScopeStorage.run(scope, fn);
}

const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

/** How long an activity waits for its sandbox session to close (WORKER_SANDBOX_CLOSE_TIMEOUT_MS). */
export function sandboxCloseTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WORKER_SANDBOX_CLOSE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLOSE_TIMEOUT_MS;
}

/**
 * Close a session without letting a close failure replace the caller's outcome: a
 * completed activity must not fail (and retry billed work) because teardown failed,
 * and a failing activity must keep its own error. Providers keep secrets out of messages.
 *
 * The wait is bounded (`timeoutMs`): a close or a session open that never settles must not hold
 * the activity's result, in particular a latched teardown failure, which has to reach Temporal as
 * non-retryable rather than be lost to the worker's force exit. The close keeps running after the
 * bound; a remote session also ends at its own provider-side timeout.
 */
export async function closeSandboxQuietly(
  close: () => Promise<void>,
  label: string,
  timeoutMs = sandboxCloseTimeoutMs(),
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closing = (async () => close())();
  try {
    const result = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs))),
    ]);
    if (result === "timeout") {
      console.error(`[parser-sandbox] status=close-timeout ${label} timeout_ms=${timeoutMs}`);
      closing.catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[parser-sandbox] session close failed ${label}: ${reason}`);
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[parser-sandbox] session close failed ${label}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
