/*
 * Vision page reader: vision-extract's plain page transcription read by the registered page image reader plugin
 * (extractors/plugins.ts pageImageReader) in its own isolated VM, instead of the run's hosted vision route
 * (DOCSLURP_VISION_PAGE_READER; docs/extraction/ocr.md, "Vision page reader").
 *
 * - Off unless the operator sets DOCSLURP_VISION_PAGE_READER (`all`, or a tier word that selects the reader). With it on,
 *   the worker refuses to start without a ready provider (page-reader-mode.ts).
 * - Only plain page transcription goes to the reader: a transcription prompt template with no output schema and no task
 *   prompt (vision-runtime.ts isPageTranscription), on a PDF page the renderer wrote as PNG, in a `standard` privacy
 *   project whose vision route is hosted. Schema and task-prompt reads, figure and chart pages, table-rescue and
 *   encoding-read pages (read under the guard's durable per-document budgets, vision-extract budgetedReadPurpose),
 *   critique passes, routed (page router) pages, page-task (fan-out) pages, raster uploads and documents without page
 *   triage keep the hosted route; so does a `local-only` or `strict-privacy` project, and a run whose configured vision
 *   route is not hosted (a local or operator-private model).
 * - The reader must declare where it processes pages (`hostCountry`) and who operates its VMs (`operatorCountry`), and the
 *   organization's provider-region policy must admit both (China needs allowChinaProviders); otherwise the run keeps its
 *   hosted route. Cost-capped runs keep it too.
 * - Jobs carry one run of one organization (readPageImagesWithProvider): a run without an organization sends nothing.
 *   They count against the organization's daily reader cost cap (one fleet-wide ledger with the OCR reader) and a
 *   per-document page budget kept per activity (as the OCR reader's is).
 * - A page the reader does not return (a failed, refused, timed-out or invalid job, a refused image, the budget or a cap)
 *   goes to the run's hosted vision route as it would without the reader. The hosted route is the run's own configured
 *   model, never an automatic fallback the system picks.
 */
import { PRIVATE_MODEL_PROVIDER, privacyModeAllowsHosted, resolveVisionRoute, type VisionConfig } from "@docslurp/shared";

import { pageImageReaderProvider, type PageImageReaderProvider } from "../extractors/plugins.js";
import { visionPageReaderMode } from "../ocr/page-reader-mode.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { currentProviderPolicy } from "../lib/provider-rate-limit.js";
import { isPageTranscription } from "../tools/vision-runtime.js";

export { VISION_PAGE_READER_METRIC } from "../ocr/page-reader-mode.js";

/**
 * Pages one hosted read takes while the run's warm-started reader boots (page-reader-warm.ts): small, so the reader's
 * readiness is checked again within a hosted round or two and later pages move to it once it is ready.
 */
export const VISION_READER_WARMING_HOSTED_CHUNK = 4;
/** Lanes a document's reader pages are read with under warm start (at most two of them run reader jobs at once). */
export const VISION_READER_WARMING_LANES = 4;

export type VisionPageReaderRefusal = "off" | "no-provider" | "privacy-mode" | "no-org-scope" | "not-transcription" | "configured-route" | "region-policy" | "cost-capped";

/** Countries whose hosts the provider-region policy treats as China-based (provider-regions.ts `cn`). */
const CHINA_HOST_COUNTRIES = new Set(["CN", "HK", "MO"]);

/**
 * Whether the organization's provider-region policy (the job's currentProviderPolicy) admits the reader's host country.
 * A reader that does not declare one is refused (fail closed).
 */
export function visionPageReaderRegionAllowed(provider: Pick<PageImageReaderProvider, "hostCountry" | "operatorCountry">, policy = currentProviderPolicy()): boolean {
  // Where pages are processed and who operates the VMs (ownership and jurisdiction): both declared, both admitted.
  for (const country of [provider.hostCountry, provider.operatorCountry]) {
    if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) return false;
    if (!policy.allowChinaProviders && CHINA_HOST_COUNTRIES.has(country)) return false;
  }
  return true;
}

/**
 * The reader for this run's plain page transcription, or why the run keeps its hosted route. Never throws: a
 * configuration the startup check would refuse reads as off (the hosted route, as without the reader).
 */
export function visionPageReaderDecision(
  state: Pick<WorkflowState, "run">,
  vision: VisionConfig,
  env: NodeJS.ProcessEnv = process.env,
): { provider: PageImageReaderProvider } | { refused: VisionPageReaderRefusal } {
  let mode: string;
  try {
    mode = visionPageReaderMode(env);
  } catch {
    return { refused: "off" };
  }
  if (mode === "off") return { refused: "off" };
  const provider = pageImageReaderProvider();
  if (!provider) return { refused: "no-provider" };
  // Only a project that allows hosted vision may have its pages read by the reader: local-only and strict-privacy keep
  // the route their own policy admits.
  if (!privacyModeAllowsHosted(state.run.pipeline.privacyMode ?? "standard")) return { refused: "privacy-mode" };
  // A cost-capped run admits one hosted page at a time; a reader job of many pages could pass the cap by its batch.
  if ((state.run.pipeline.maxCostCents ?? 0) > 0) return { refused: "cost-capped" };
  if (typeof state.run.orgId !== "string" || !state.run.orgId || !state.run.id) return { refused: "no-org-scope" };
  if (!isPageTranscription({ vision, outputSchema: state.run.pipeline.outputSchema ?? null })) return { refused: "not-transcription" };
  let route: ReturnType<typeof resolveVisionRoute>;
  try {
    route = resolveVisionRoute(vision);
  } catch {
    return { refused: "configured-route" };
  }
  // Only a hosted route is replaced: a run pinned to a local model (local-cli, or a loopback OpenAI-compatible server such
  // as vLLM or Ollama) or an operator-private model keeps it, so the reader never adds egress such a run did not have.
  if (route.target !== "hosted" || vision.target !== "hosted" || route.runtime === "local-cli" || route.provider === PRIVATE_MODEL_PROVIDER) {
    return { refused: "configured-route" };
  }
  // The organization's provider-region policy applies to the reader's host as to every hosted provider.
  if (!visionPageReaderRegionAllowed(provider)) return { refused: "region-policy" };
  return { provider };
}

export function visionPageReaderFor(state: Pick<WorkflowState, "run">, vision: VisionConfig, env: NodeJS.ProcessEnv = process.env): PageImageReaderProvider | null {
  const decision = visionPageReaderDecision(state, vision, env);
  return "provider" in decision ? decision.provider : null;
}
