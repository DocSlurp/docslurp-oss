/*
 * Doppler page facts a sandboxed PDF run returned (`SandboxedPdfResult.pageFacts`, doppler-page-facts/1 JSON lines),
 * accepted per job beside the run's other outputs (extractors/plugins.ts acceptSandboxedPdfResult).
 *
 * Rules:
 * - The facts are untrusted guest output. They are parsed once, by the strict bounded reader (lib/doppler-page-facts.ts),
 *   bounded by the page count the host measured; a refused or unusable stream is dropped (unknown), never repaired.
 * - Routing evidence only: they never bill, never authorize a read, and never replace the host's page count.
 * - DOCSLURP_DOPPLER_PAGE_FACTS: `off` drops them unread; `store` (default) keeps them for the page-facts artifact; `use`
 *   also lets them stand in for layout facts when the provider returned none.
 */
import { parseDopplerPageFacts, dopplerPageFactsMode, type DopplerPageFactsDocument } from "../lib/doppler-page-facts.js";
import { pageLayoutFactsFromDopplerFacts } from "../lib/doppler-page-facts-layout.js";
import type { PageLayoutFacts } from "../lib/page-layout-facts.js";

/** The job object of a run (extractors/plugins.ts SandboxedPdfJob); only its identity is used here. */
type Job = object;

const accepted = new WeakMap<Job, { facts: DopplerPageFactsDocument; layout: Map<number, PageLayoutFacts> | null }>();

/**
 * Parse a run's raw `pageFacts` for `job` (replacing anything an earlier result left), bounded by `pages`, the host's own
 * page count. Never throws on provider input: unusable facts are dropped with a warning.
 */
export function acceptSandboxedPdfPageFacts(job: Job, raw: unknown, pages: number, env: NodeJS.ProcessEnv = process.env): void {
  accepted.delete(job);
  if (raw === undefined) return;
  const mode = dopplerPageFactsMode(env);
  if (mode === "off") return;
  const parsed = parseDopplerPageFacts(raw, { pageCount: pages });
  if (!parsed.ok) {
    console.warn(`[vm-pdf] page facts refused reason=${parsed.reason}; continuing without them`);
    return;
  }
  const { facts } = parsed;
  if (facts.summary.linesDropped > 0 || !facts.summary.complete) {
    console.warn(`[vm-pdf] page facts partial pagesKnown=${facts.summary.pagesKnown} linesDropped=${facts.summary.linesDropped} complete=${facts.summary.complete}`);
  }
  const layout = mode === "use" ? pageLayoutFactsFromDopplerFacts(facts) : null;
  accepted.set(job, { facts, layout: layout && layout.size > 0 ? layout : null });
}

/** The validated page facts of a finished job, or undefined when it returned none usable (or they are off). */
export function sandboxedPdfPageFacts(job: Job): DopplerPageFactsDocument | undefined {
  return accepted.get(job)?.facts;
}

/** Layout facts mapped from the job's page facts: only in `use` mode, and only when any page is known. */
export function sandboxedPdfPageFactsLayout(job: Job): Map<number, PageLayoutFacts> | undefined {
  return accepted.get(job)?.layout ?? undefined;
}

/**
 * The raw facts in a form that survives JSON storage (the first pass keeps a batch result to serve it again, where it is
 * accepted again): a string within the reader's absolute ceiling, or undefined.
 */
export function pageFactsForResend(raw: unknown, maxBytes: number): string | undefined {
  if (typeof raw === "string") return raw.length <= maxBytes ? raw : undefined;
  if (raw instanceof Uint8Array && raw.byteLength <= maxBytes) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1");
  return undefined;
}
