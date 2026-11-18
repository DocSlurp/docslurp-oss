import type { Context, MiddlewareHandler } from "hono";
import { deprecatedExtractionFields, PAGE_IMAGES_FORCED_WARNING, smartestLocksPageImages, type DeprecatedFieldWarning } from "@docslurp/shared";
import { recordDeprecatedRequestFields, takeDeprecatedRequestFields, type RequestFieldWarning } from "./request-context.js";

/**
 * Deprecated request fields (extraction-config.ts): a request that uses an old name still works during the window, and
 * its response says so with a `Deprecation: true` header and a `warnings[]` array (each `{ code: "deprecated_field",
 * field, replacement, message }`) merged into a JSON object body. Routes and services call `markDeprecatedFields` (recorded on the request context); the
 * `deprecationWarnings` middleware writes them onto whatever response the route returns, success or error.
 */
export function markDeprecatedFields(_c: Context | null, warnings: readonly RequestFieldWarning[]): void {
  recordDeprecatedRequestFields(warnings);
}

/** Deprecated fields of a reprocess body: `chartExport` (use `visuals`). */
export function deprecatedReprocessFields(body: { chartExport?: unknown } | null | undefined): DeprecatedFieldWarning[] {
  return body?.chartExport ? [{ code: "deprecated_field", field: "chartExport", replacement: "visuals", message: "'chartExport' is deprecated; use 'visuals'." }] : [];
}

/** Deprecated fields of a request pipeline (`pipeline.quality: "auto"`, `pipeline.visionFallback`, `pipeline.figures`, `pipeline.chartExport.tier`). */
export function deprecatedPipelineFields(pipeline: unknown, prefix = "pipeline."): RequestFieldWarning[] {
  const warnings: RequestFieldWarning[] = deprecatedExtractionFields(pipeline, prefix);
  // Smartest always stores page images: a request asking for both keeps them on (normalizePipelineFeatures) and says so.
  if (pipeline && typeof pipeline === "object" && smartestLocksPageImages(requestLevelFields(pipeline as Record<string, unknown>))) {
    warnings.push({ ...PAGE_IMAGES_FORCED_WARNING, field: `${prefix}pageImages` });
  }
  return warnings;
}

/** A request's quality as stored fields, so a level word (`smartest`) reads like the stored ladder it becomes. */
function requestLevelFields(pipeline: Record<string, unknown>): { quality?: unknown; ladder?: unknown; pageImages?: unknown } {
  const level = pipeline.quality === "smartest" || pipeline.quality === "smart" || pipeline.quality === "good";
  return level ? { quality: "auto", ladder: { maxRung: "intelligent" }, pageImages: pipeline.pageImages } : pipeline;
}

export const deprecationWarnings: MiddlewareHandler = async (c, next) => {
  await next();
  const warnings = takeDeprecatedRequestFields();
  if (!warnings.length) return;
  if (warnings.some((warning) => warning.code === "deprecated_field")) c.res.headers.set("Deprecation", "true");
  const type = c.res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return;
  try {
    const body = await c.res.clone().json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const record = body as Record<string, unknown>;
    const existing = Array.isArray(record.warnings) ? record.warnings : [];
    // A route that already answers `warnings` as strings keeps that shape: the deprecations join as their messages.
    const additions = existing.some((entry) => typeof entry === "string") ? warnings.map((warning) => warning.message) : warnings;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify({ ...record, warnings: [...existing, ...additions] }), { status: c.res.status, statusText: c.res.statusText, headers });
  } catch {
    // A body that is not JSON keeps the header only.
  }
};
