import { sha256Hex } from "./hash.js";
import { PAGE_RASTER_ROUTING } from "./page-raster-routing.js";
import { PAGE_TABLE_ROUTING } from "./page-table-routing.js";

/**
 * The neutral evidence and routing rules the router and the offline profiler share (`packages/estimate/profiler-rules.json`):
 * thresholds over measured structure only, with no prices, rates, multipliers or plans. The worker's router reads the same
 * constants at runtime; the committed file, the Rust/WASM estimator and this generator must agree, so a profile measures what
 * billing will. Pricing is not here: it belongs to the pricing provider.
 */
export const PROFILER_RULES_SCHEMA = 1;

export function buildProfilerRules() {
  const body = {
    schema: PROFILER_RULES_SCHEMA,
    pageRasterRouting: { ...PAGE_RASTER_ROUTING },
    pageTableRouting: { ...PAGE_TABLE_ROUTING },
  };
  return { ...body, revision: sha256Hex(JSON.stringify(body)) };
}
