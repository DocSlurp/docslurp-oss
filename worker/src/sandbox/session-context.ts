import { AsyncLocalStorage } from "node:async_hooks";

import type { SandboxSession } from "./types.js";

/**
 * One sandbox session per scope (one Temporal activity). The session opens
 * lazily on first use so activities that never run a parser cost nothing.
 */
export class SandboxSessionScope {
  private opening: Promise<SandboxSession> | null = null;

  constructor(private readonly open: () => Promise<SandboxSession>) {}

  get(): Promise<SandboxSession> {
    this.opening ??= this.open();
    return this.opening;
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

export function runWithSandboxScope<T>(scope: SandboxSessionScope, fn: () => Promise<T>): Promise<T> {
  return sandboxScopeStorage.run(scope, fn);
}
