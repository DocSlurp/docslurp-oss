/** The parser-VM guest's imports, bundled into one module by `scripts/bundle-chart-guest.mjs` at build time. */
import { disableSchemaJit } from "@docslurp/shared/chart-export";

// The guest evaluates no generated code: zod's JIT (the Function constructor) is off before any schema parses.
disableSchemaJit();

export { extractDeterministicVisuals, markerBudget } from "./index.js";
export { CHART_EXTRACT_LIMITS } from "./limits.js";
