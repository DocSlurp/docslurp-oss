import { AsyncLocalStorage } from "node:async_hooks";

import type { MaterializationPolicy } from "@docslurp/shared";

import type { ValidatedKey } from "../../services/api-keys.js";

export type MaterializeEvent = {
  type: "page-materializing" | "page-ready" | "materialize-failed";
  documentId: string;
  pages: number[];
};

/**
 * Request-scoped inputs to deferred search that do not belong in `SearchOptions`
 * (they must never be user-controllable fields of the search body): the policy
 * resolved from the caller's key and capability, and an event sink the SSE
 * route uses to stream materialization progress.
 */
export interface DeferredRequestContext {
  /** Pre-resolved (and validated) policy; otherwise resolved from `apiKey` at search time. */
  policy?: MaterializationPolicy;
  apiKey?: ValidatedKey | null;
  onEvent?: (event: MaterializeEvent) => void;
  /** Aborted when the client goes away: stop waiting on materialization and skip the answer LLM. */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<DeferredRequestContext>();

export function withDeferredContext<T>(context: DeferredRequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function getDeferredContext(): DeferredRequestContext | undefined {
  return storage.getStore();
}
