/*
 * Doppler page facts a sandboxed PDF run returned (`SandboxedPdfResult.pageFacts`, doppler-page-facts/1 JSON lines),
 * accepted per job beside the run's other outputs (extractors/plugins.ts acceptSandboxedPdfResult).
 *
 * Rules:
 * - The facts are untrusted guest output. They are parsed once, by the strict bounded reader (lib/doppler-page-facts.ts),
 *   bounded by the page count the host measured; a refused or unusable stream is dropped (unknown), never repaired.
 * - Routing evidence only: they never bill, never authorize a read, and never replace the host's page count.
 * - DOCSLURP_DOPPLER_PAGE_FACTS: `off` drops them unread; `store` (default) records their text layer and scan class per page
 *   (document_page_facts, through upsertPageFacts); `use`
 *   also lets them stand in for layout facts when the provider returned none.
 */
import { parseDopplerPageFacts, dopplerPageFactsJsonl, dopplerPageFactsMode, type DopplerPageFactsDocument } from "../lib/doppler-page-facts.js";
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
  // Without a page count the host measured, facts have nothing to be bounded by: unknown.
  if (!Number.isSafeInteger(pages) || pages < 1) {
    console.warn("[vm-pdf] page facts dropped: no host page count");
    return;
  }
  let parsed: ReturnType<typeof parseDopplerPageFacts>;
  try {
    parsed = parseDopplerPageFacts(raw, { pageCount: pages });
  } catch {
    // The reader does not throw on bytes; an exotic object a plugin built might. Unknown, never a refused run.
    console.warn("[vm-pdf] page facts refused reason=unreadable; continuing without them");
    return;
  }
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

/** Forget what an earlier result of `job` left (before anything about a new result can throw). */
export function clearSandboxedPdfPageFacts(job: Job): void {
  accepted.delete(job);
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
 * The job's validated facts as canonical lines, for a caller that hands them on to be accepted again (the first pass's
 * stored batch result): never the guest's raw bytes. Undefined when the job has none (refused, absent, or off).
 */
export function pageFactsForResend(job: Job): string | undefined {
  const facts = accepted.get(job)?.facts;
  return facts ? dopplerPageFactsJsonl(facts) : undefined;
}
