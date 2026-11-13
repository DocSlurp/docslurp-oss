/** The parser-VM guest's imports, bundled into one module by `scripts/bundle-chart-guest.mjs` at build time. */
// FIRST: zod reads `jitless` when each schema is built, so this must evaluate before anything that builds one. ESM
// evaluates imports in order and esbuild keeps that order; `guest-bundle.test.ts` checks it under V8's
// --disallow-code-generation-from-strings, which the host also passes to every guest run.
import "@docslurp/shared/zod-jitless";

export { extractDeterministicVisuals } from "./index.js";
export { CHART_EXTRACT_LIMITS, setGuestDeadline } from "./limits.js";
