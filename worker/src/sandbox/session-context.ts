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

/**
 * Close a session without letting a close failure replace the caller's outcome: a
 * completed activity must not fail (and retry billed work) because teardown failed,
 * and a failing activity must keep its own error. Providers keep secrets out of messages.
 */
export async function closeSandboxQuietly(close: () => Promise<void>, label: string): Promise<void> {
  try {
    await close();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[parser-sandbox] session close failed ${label}: ${reason}`);
  }
}
