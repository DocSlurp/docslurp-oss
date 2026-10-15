import { AsyncLocalStorage } from "node:async_hooks";

/** Dependency-free correlation context: safe during Astro prerendering too. */
export const errorContext = new AsyncLocalStorage<{ requestId: string; userId?: string }>();
