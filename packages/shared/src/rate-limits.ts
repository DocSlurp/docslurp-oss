import { z } from "zod";
import { searchModeSchema } from "./project.js";

/**
 * Per-API-key custom limits, layered on top of the key's requests-per-minute
 * baseline and the plan's per-category limits.
 *
 * - `requests`: at most `limit` API requests per rolling `windowSeconds`, across all endpoints.
 * - `spend`: at most `limit` US cents of attributed usage (AI, embedding and compute
 *   spend from `usage_events`) per rolling `windowSeconds`. Spend is recorded after the
 *   work it pays for, so a spend limit stops new cost-incurring requests once crossed;
 *   it is not a hard ceiling on a request already running.
 * - `concurrent`: at most `limit` AI chat turns (streams included) in progress at once
 *   for this key, per server process. `windowSeconds` is ignored (send 1). Server keys
 *   have no default cap; browser keys default to 16.
 * - `searches`: at most `limit` searches that ran in `mode` (keyword, hybrid or deep) per
 *   `windowSeconds`, counted when the search starts. A search the key's limit for its
 *   mode refuses answers 429 `search_limit_exceeded`; the caller may retry in a cheaper
 *   mode (`mode=keyword`), which its own limit governs. Cached answers and the searches a
 *   chat turn runs are not counted.
 */
export const apiKeyRateLimitMetrics = ["requests", "spend", "concurrent", "searches"] as const;
export type ApiKeyRateLimitMetric = (typeof apiKeyRateLimitMetrics)[number];

export const API_KEY_RATE_LIMIT_MAX_RULES = 8;
export const API_KEY_RATE_LIMIT_MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60;

export const apiKeyRateLimitRuleSchema = z.object({
  metric: z.enum(apiKeyRateLimitMetrics),
  /** Requests for `requests`; US cents for `spend`; searches for `searches`. */
  limit: z.number().int().positive().max(100_000_000),
  windowSeconds: z.number().int().positive().max(API_KEY_RATE_LIMIT_MAX_WINDOW_SECONDS),
  /** The search mode a `searches` limit counts; required for `searches`, refused on other metrics. */
  mode: searchModeSchema.optional(),
}).refine((rule) => (rule.metric === "searches") === (rule.mode !== undefined), {
  message: "A searches limit names its mode (keyword, hybrid or deep); other limits have no mode",
  path: ["mode"],
});
export type ApiKeyRateLimitRule = z.infer<typeof apiKeyRateLimitRuleSchema>;

export const apiKeyRateLimitRulesSchema = z.array(apiKeyRateLimitRuleSchema)
  .max(API_KEY_RATE_LIMIT_MAX_RULES)
  .refine(
    (rules) => new Set(rules.map((rule) => `${rule.metric}:${rule.mode ?? ""}:${rule.metric === "concurrent" ? 0 : rule.windowSeconds}`)).size === rules.length,
    { message: "Use one limit per metric, mode and window (and at most one concurrent limit)" },
  );

/** Short, stable policy name for headers, e.g. `key-requests-1h` or `key-spend-30d`. */
export function apiKeyRateLimitPolicyName(rule: Pick<ApiKeyRateLimitRule, "metric" | "windowSeconds" | "mode">): string {
  return `key-${rule.metric}${rule.mode ? `-${rule.mode}` : ""}-${formatRateLimitWindow(rule.windowSeconds)}`;
}

/** Compact window label: 90 → `90s`, 3600 → `1h`, 86400 → `1d`. */
export function formatRateLimitWindow(windowSeconds: number): string {
  for (const [unit, seconds] of [["d", 86_400], ["h", 3_600], ["m", 60]] as const) {
    if (windowSeconds % seconds === 0) return `${windowSeconds / seconds}${unit}`;
  }
  return `${windowSeconds}s`;
}
