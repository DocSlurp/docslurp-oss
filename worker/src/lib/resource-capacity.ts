import { AsyncLocalStorage } from "node:async_hooks";

/** Retry the stage after pressure clears; never mark an unstarted document completed. */
export class ResourceCapacityError extends Error {
  readonly retryable = true;
  constructor() {
    super("Insufficient memory headroom for one document; retry after resource pressure clears");
    this.name = "ResourceCapacityError";
  }
}


const admission = new AsyncLocalStorage<() => void>();

/** Scope a resource check to one activity; concurrent tenants never share callbacks. */
export function withResourceCapacityGuard<T>(check: () => void, work: () => T): T {
  return admission.run(check, work);
}

/** Check at actual command/request admission, after cache and policy decisions. */
export function assertResourceCapacity(): void {
  admission.getStore()?.();
}
