import type { MiddlewareHandler } from "hono";
import { customerPipelineView, MANAGED_PIPELINE_MODEL_PATHS } from "@docslurp/shared";
import { getRequestActor, isPlatformAdminActor, type RequestActor } from "../lib/request-actor.js";

/** Responses larger than this are passed through (search pages and exports carry no pipeline; parsing them costs). */
const MAX_GUARDED_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 16;
/**
 * Text that any managed model value brings with it: its key (every managed-pipeline-models.ts path's last key, `target`
 * and `route` included) or a model route (`llm://`, `vlm:`). A pipeline that names its model only through
 * `visualPages.route` or a `target` still triggers the parse (council round 5, R5-1).
 */
const MANAGED_FIELD_KEYS = [
  ...new Set(MANAGED_PIPELINE_MODEL_PATHS.map((path) => `"${path.split(".").at(-1)!}"`)),
  "llm://",
  "vlm:",
];

/** Every object under a `pipeline` key, at any depth, with its managed model fields removed. */
export function withCustomerPipelines(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => withCustomerPipelines(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    key === "pipeline" && item && typeof item === "object" && !Array.isArray(item)
      ? customerPipelineView(item)
      : withCustomerPipelines(item, depth + 1),
  ]));
}

/**
 * Backstop for the managed-models guarantee: a JSON response to anyone but a platform operator never carries a
 * pipeline's managed model fields (model ids, model routes, operator private routes). Routes already return customer
 * views (publicProjectView, redactOperatorRun); this catches a route that forgets. Only responses whose text mentions
 * `"pipeline"` are parsed; streams and non-JSON bodies pass through untouched.
 */
export const customerPipelineGuard: MiddlewareHandler = async (c, next) => {
  await next();
  const response = c.res;
  const type = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type) || !response.body) return;
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_GUARDED_BYTES) return;
  const text = await response.clone().text();
  if (text.length > MAX_GUARDED_BYTES || !text.includes("\"pipeline\"")) return;
  // A response that names no managed key or model route: skip the parse (~10 ms on a 450 KB run list).
  if (!MANAGED_FIELD_KEYS.some((key) => text.includes(key))) return;
  // Only now the operator check (a server key's costs a query): most responses carry no pipeline.
  let actor: RequestActor | undefined;
  try { actor = getRequestActor(c); } catch { actor = undefined; } // unauthenticated: a customer view
  if (actor && await isPlatformAdminActor(actor)) return;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return; }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(withCustomerPipelines(parsed)), { status: response.status, statusText: response.statusText, headers });
};
