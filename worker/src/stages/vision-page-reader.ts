/*
 * Vision page reader: vision-extract's plain page transcription read by the registered page image reader plugin
 * (extractors/plugins.ts pageImageReader) in its own isolated VM, instead of the run's hosted vision route
 * (DOCSLURP_VISION_PAGE_READER; docs/extraction/ocr.md, "Vision page reader").
 *
 * - Off unless the operator sets DOCSLURP_VISION_PAGE_READER (`all`, or a tier word that selects the reader). With it on,
 *   the worker refuses to start without a ready provider (page-reader-mode.ts).
 * - Only plain page transcription goes to the reader: a transcription prompt template with no output schema and no task
 *   prompt (vision-runtime.ts isPageTranscription), on a PDF page the renderer wrote as PNG, in a `standard` privacy
 *   project whose vision route is hosted. Schema and task-prompt reads, figure and chart pages, table-rescue pages,
 *   critique passes, routed (page router) pages, page-task (fan-out) pages, raster uploads and documents without page
 *   triage keep the hosted route; so does a `local-only` or `strict-privacy` project, and a run whose configured vision
 *   route is not hosted (a local or operator-private model).
 * - Jobs carry one run of one organization (readPageImagesWithProvider): a run without an organization sends nothing.
 *   They count against the organization's daily reader cost cap (one fleet-wide ledger with the OCR reader) and a
 *   per-document page budget kept per activity (as the OCR reader's is).
 * - A page the reader does not return (a failed, refused, timed-out or invalid job, a refused image, the budget or a cap)
 *   goes to the run's hosted vision route as it would without the reader. The hosted route is the run's own configured
 *   model, never an automatic fallback the system picks.
 */
import { PRIVATE_MODEL_PROVIDER, resolveVisionRoute, type VisionConfig } from "@docslurp/shared";

import { pageImageReaderProvider, type PageImageReaderProvider } from "../extractors/plugins.js";
import { visionPageReaderMode } from "../ocr/page-reader-mode.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { isPageTranscription } from "../tools/vision-runtime.js";

export { VISION_PAGE_READER_METRIC } from "../ocr/page-reader-mode.js";

export type VisionPageReaderRefusal = "off" | "no-provider" | "privacy-mode" | "no-org-scope" | "not-transcription" | "configured-route";

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
  if ((state.run.pipeline.privacyMode ?? "standard") !== "standard") return { refused: "privacy-mode" };
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
  return { provider };
}

export function visionPageReaderFor(state: Pick<WorkflowState, "run">, vision: VisionConfig, env: NodeJS.ProcessEnv = process.env): PageImageReaderProvider | null {
  const decision = visionPageReaderDecision(state, vision, env);
  return "provider" in decision ? decision.provider : null;
}
