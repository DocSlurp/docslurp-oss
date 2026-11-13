/** The parser-VM guest's imports, bundled into one module by `scripts/bundle-chart-guest.mjs` at build time. */
// FIRST: zod reads `jitless` when each schema is built, so this must evaluate before anything that builds one. ESM
// evaluates imports in order and esbuild keeps that order; `guest-bundle.test.ts` checks it under V8's
// --disallow-code-generation-from-strings, which the host also passes to every guest run.
import "@docslurp/shared/zod-jitless";

export { extractDeterministicVisuals } from "./index.js";
export { CHART_EXTRACT_LIMITS, setGuestDeadline } from "./limits.js";

/**
 * Fault injection for the containment tests only (council r9 L3). `__CHART_GUEST_TEST_HOOKS__` is a build-time
 * constant: the production bundle is built with it `false`, so these hooks are dead code there and no environment
 * variable can enable them (`parser-vm-contract.mjs` checks `testHooks === null`). The containment tests build their own
 * bundle with it `true` and copy the guest scripts beside it.
 */
declare const __CHART_GUEST_TEST_HOOKS__: boolean | undefined;
export interface ChartGuestTestHooks {
  /** "<crash|hang|oom>:<locator substring>": fail the first unit whose locator contains it. */
  fault: string | null;
  heapMb: number | null;
  unitMs: number | null;
}
export const testHooks: ChartGuestTestHooks | null = typeof __CHART_GUEST_TEST_HOOKS__ !== "undefined" && __CHART_GUEST_TEST_HOOKS__
  ? {
      fault: process.env.DOCSLURP_CHART_GUEST_TEST_FAULT ?? null,
      heapMb: Number(process.env.DOCSLURP_CHART_GUEST_TEST_HEAP_MB) > 0 ? Number(process.env.DOCSLURP_CHART_GUEST_TEST_HEAP_MB) : null,
      unitMs: Number(process.env.DOCSLURP_CHART_GUEST_TEST_UNIT_MS) > 0 ? Number(process.env.DOCSLURP_CHART_GUEST_TEST_UNIT_MS) : null,
    }
  : null;
