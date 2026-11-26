import {
  PII_BLOCKED_DOCUMENT_STATUS,
  PII_DETECTOR_VALIDATION,
  piiCategoryIds,
  piiWithholding,
  withheldPageOfSlot,
  type PiiPatternType,
  type PiiPolicy,
} from "@docslurp/shared";

import { scrubTitlesAndMapForPii, type WithheldPagesForMap } from "./pii-document-map.js";
import { withdrawSummaryTreeForPii } from "../summary-tree/state-store.js";

/**
 * The page-scoped PII outcome for pages a deferred read matched (docs/pii-page-withholding.md).
 *
 * Deferred indexing modes skip `pii-detect`: pages are read one by one later (the document map's rough text, then
 * materialization), and each read is scanned on its own. A page whose read matches is recorded here exactly as the
 * ingest scan records a withheld page, merged with any outcome the document already has, so every reader (search,
 * page renders, page-image readiness, the file proxy, the source download, exports, the viewer and the ingest report)
 * answers from the one `metadata.pii` object through `piiWithholding()`.
 */
export type DeferredPiiMatch = {
  /** Kinds of PII found on each matched page. */
  pages: ReadonlyMap<number, readonly PiiPatternType[]>;
  action: PiiPolicy["action"];
  runId: string;
  pageCount: number;
  /** The source file and every recorded artifact of the document that is not a clean page's own image or figure. */
  withheldArtifactUris: readonly string[];
  /**
   * Pages this read scanned (deferred modes). Until every page has been scanned the outcome lists them
   * (`scanPending`, `scannedPages`) and readers withhold every other page and the source. `reset` starts a new scan
   * (the document map of a new run); otherwise pages are added to the scan in progress. Absent: scan state unchanged.
   */
  scan?: { pages: ReadonlySet<number>; reset: boolean };
};

/** What a caller knows about a deferred match; the artifacts to withhold are read from the document's run. */
export type DeferredPiiMatchInput = Omit<DeferredPiiMatch, "withheldArtifactUris"> & {
  sourceUri: string;
  /** The policy scanner: titles and map entries it matches are scrubbed with the match. */
  matches?: (text: string) => boolean;
};

/** Artifacts a page-scoped outcome withholds: the source, every slot without a page, and the withheld pages' own slots. */
export function deferredWithheldArtifactUris(
  artifacts: Readonly<Record<string, string>> | null | undefined,
  documentId: string,
  sourceUri: string,
  withheldPages: ReadonlySet<number>,
): string[] {
  const prefix = `${documentId}:`;
  const out = new Set<string>([sourceUri]);
  for (const [slot, uri] of Object.entries(artifacts ?? {})) {
    if (!slot.startsWith(prefix) || typeof uri !== "string" || !uri.includes("://")) continue;
    const page = withheldPageOfSlot(slot.slice(prefix.length));
    if (page === null || withheldPages.has(page)) out.add(uri);
  }
  return [...out].sort();
}

type StoredPii = Record<string, unknown>;

/**
 * The merged `metadata.pii` for a deferred match. Pure: `existing` is the stored object (or null). Fail closed: an
 * existing outcome the readers already treat as whole-document stays so; page withholding only grows; every page
 * withheld blocks the document.
 */
export function mergeDeferredPiiOutcome(
  existing: { status: string | null; pii: unknown },
  match: DeferredPiiMatch,
): { pii: StoredPii; blocked: boolean; withheldPages: number[] } | null {
  const current = piiWithholding({ status: existing.status, metadata: { pii: existing.pii ?? null } });
  if (current.scope === "document") return null;
  const stored: StoredPii = existing.pii && typeof existing.pii === "object" && !Array.isArray(existing.pii) ? { ...(existing.pii as StoredPii) } : {};
  const redacting = match.action === "redact_artifacts";
  const blocking = match.action === "block_indexing" || match.action === "block_document";
  if (!redacting && !blocking) return null;
  const scanFields = mergeScan(stored, existing.pii, match);
  if (match.pages.size === 0) {
    // Scan progress only: nothing matched, so nothing new is withheld.
    if (scanFields === "unchanged") return null;
    const { scanPending: _pending, scannedPages: _scanned, ...rest } = stored;
    const pii: StoredPii = Object.keys(stored).length > 0
      ? { ...rest, ...scanFields }
      : { scope: "none", action: match.action, runId: match.runId, pageCount: match.pageCount, blocked: false, redacted: false, reviewRequired: false, withheldArtifactUris: [], ...scanFields };
    return { pii, blocked: false, withheldPages: current.scope === "pages" ? [...current.pages].sort((a, b) => a - b) : [] };
  }

  const pageTypes = new Map<number, PiiPatternType[]>();
  if (current.scope === "pages") for (const page of current.pages) pageTypes.set(page, [...(current.pageTypes?.get(page) ?? [])]);
  const newTypes = new Set<PiiPatternType>();
  for (const [page, types] of match.pages) {
    for (const type of types) newTypes.add(type);
    if (blocking) pageTypes.set(page, piiCategoryIds([...(pageTypes.get(page) ?? []), ...types]));
  }
  const patternTypes = piiCategoryIds([...piiCategoryIds(stored.patternTypes), ...newTypes]);
  const withheldArtifactUris = [...new Set([
    ...(Array.isArray(stored.withheldArtifactUris) ? stored.withheldArtifactUris.filter((uri): uri is string => typeof uri === "string") : []),
    ...match.withheldArtifactUris,
  ])].sort();
  const withheldPages = [...pageTypes.keys()].sort((a, b) => a - b);
  const blocked = match.action === "block_document" || (withheldPages.length > 0 && withheldPages.length >= match.pageCount);
  const { scanPending: _pending, scannedPages: _scanned, ...storedWithoutScan } = stored;
  const scanState = scanFields === "unchanged" ? scanOf(stored) : scanFields;
  const base: StoredPii = {
    ...storedWithoutScan,
    ...scanState,
    action: stored.action ?? match.action,
    runId: stored.runId ?? match.runId,
    pageCount: match.pageCount,
    patternTypes,
    withheldArtifactUris,
    reviewRequired: stored.reviewRequired === true,
    detectedAt: new Date().toISOString(),
  };
  // The match count is not tenant-visible (categories and pages only).
  delete base.matchCount;
  if (blocked) {
    const { withheldPages: _pages, withheldPageCount: _count, withheldPageTypes: _types, scanPending: _p, scannedPages: _s, ...rest } = base;
    return {
      pii: { ...rest, scope: "document", blocked: true, redacted: false, reason: match.action === "block_document" ? "PII policy blocked indexing: a deferred page matched" : "PII policy blocked indexing: every page withheld" },
      blocked: true,
      withheldPages,
    };
  }
  if (redacting) {
    const known = Array.isArray(stored.redactedPages) ? stored.redactedPages.filter((page): page is number => Number.isSafeInteger(page) && page >= 1) : [];
    // An outcome that redacted without recording its pages (an older scan) keeps every page's pixels unknown.
    const pagesKnown = stored.redacted !== true || Array.isArray(stored.redactedPages);
    return {
      pii: {
        ...base, scope: current.scope === "pages" ? "pages" : (stored.scope ?? "none"), blocked: false, redacted: true,
        ...(pagesKnown ? { redactedPages: [...new Set([...known, ...match.pages.keys()])].sort((a, b) => a - b) } : {}),
        reason: stored.reason ?? "PII policy redacted matches",
      },
      blocked: false,
      withheldPages,
    };
  }
  return {
    pii: {
      ...base, scope: "pages", blocked: false, redacted: stored.redacted === true,
      withheldPages, withheldPageCount: withheldPages.length,
      withheldPageTypes: Object.fromEntries(withheldPages.filter((page) => (pageTypes.get(page) ?? []).length > 0).map((page) => [String(page), pageTypes.get(page)!])),
      reason: `PII policy withheld ${withheldPages.length} page${withheldPages.length === 1 ? "" : "s"}`,
    },
    blocked: false,
    withheldPages,
  };
}

function scanOf(stored: StoredPii): StoredPii {
  return stored.scanPending === true ? { scanPending: true, scannedPages: stored.scannedPages } : {};
}

/**
 * The scan fields after this read: `{}` when every page has been scanned (or no scan is tracked), else `scanPending`
 * with the sorted scanned pages. "unchanged" when the read carries no scan or adds nothing.
 */
function mergeScan(stored: StoredPii, rawPii: unknown, match: DeferredPiiMatch): StoredPii | "unchanged" {
  if (!match.scan) return "unchanged";
  const hasOutcome = rawPii !== null && rawPii !== undefined;
  const pending = stored.scanPending === true;
  // An outcome with no scan in progress was a complete scan (an ingest scan, or a deferred one that finished): a later
  // page read adds nothing unless a new scan starts.
  if (hasOutcome && !pending && !match.scan.reset) return "unchanged";
  const before = pending && !match.scan.reset
    ? new Set((Array.isArray(stored.scannedPages) ? stored.scannedPages : []).filter((page): page is number => Number.isSafeInteger(page) && page >= 1))
    : new Set<number>();
  const size = before.size;
  for (const page of match.scan.pages) if (Number.isSafeInteger(page) && page >= 1 && page <= match.pageCount) before.add(page);
  if (pending && !match.scan.reset && before.size === size) return "unchanged";
  if (before.size >= match.pageCount) return {};
  return { scanPending: true, scannedPages: [...before].sort((a, b) => a - b) };
}

type Sql = {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  json: (value: unknown) => unknown;
};

/** The findings table is not there yet (a worker deployed before its migration): retried as infrastructure, never a document failure. */
export class PiiFindingsUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("pii_page_findings is not available: run the migration before deploying this worker", options);
    this.name = "PiiFindingsUnavailableError";
  }
}

/** Runs a findings statement; a missing table (SQLSTATE 42P01) becomes {@link PiiFindingsUnavailableError}. */
export async function findingsStatement<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "42P01" || /relation "?pii_page_findings"? does not exist/i.test(message)) throw new PiiFindingsUnavailableError({ cause: error });
    throw error;
  }
}

/**
 * Record a deferred match on the document, under its row lock (concurrent page reads merge, never overwrite), inside
 * the caller's transaction: the merged outcome, the document status when every page is withheld, the operator-only
 * findings rows of the matched pages, and the page rows of withheld pages. Returns the pages now withheld, or null when
 * the document was already withheld whole (nothing to add).
 */
export async function recordDeferredPiiMatch(sql: Sql, documentId: string, input: DeferredPiiMatchInput): Promise<{ blocked: boolean; withheldPages: number[] } | null> {
  if (input.pages.size === 0 && !input.scan) return null;
  const [row] = await sql<Array<{ status: string | null; pii: unknown; artifacts: Record<string, string> | null }>>`
    select d.status, d.metadata->'pii' as pii, r.artifacts
    from documents d left join project_runs r on r.id = d.run_id
    where d.id = ${documentId} for update of d
  `;
  if (!row) return null;
  const existingPages = piiWithholding({ status: row.status, metadata: { pii: row.pii ?? null } });
  const withheld = new Set<number>([...(existingPages.scope === "pages" ? existingPages.pages : []), ...(input.action === "redact_artifacts" ? [] : input.pages.keys())]);
  // Under redaction the matched pages' own images still show the value: withheld too.
  for (const page of input.action === "redact_artifacts" ? input.pages.keys() : []) withheld.add(page);
  const match: DeferredPiiMatch = { ...input, withheldArtifactUris: deferredWithheldArtifactUris(row.artifacts, documentId, input.sourceUri, withheld) };
  const merged = mergeDeferredPiiOutcome(row, match);
  if (!merged) return null;
  await sql`
    update documents
    set metadata = (coalesce(metadata, '{}'::jsonb) - 'piiBlocked') || jsonb_build_object('pii', ${sql.json(merged.pii)}::jsonb),
        status = case when ${merged.blocked} then ${PII_BLOCKED_DOCUMENT_STATUS} else status end,
        updated_at = now()
    where id = ${documentId}
  `;
  const findings = [...match.pages].flatMap(([page, types]) => piiCategoryIds(types).map((type) => ({ page, type })));
  if (findings.length > 0 && match.action !== "redact_artifacts") {
    await findingsStatement(() => sql`
      insert into pii_page_findings (document_id, org_id, project_id, run_id, page_number, pattern_type, detector, validation, confidence)
      select d.id, d.org_id, d.project_id, ${match.runId}, f.page_number, f.pattern_type, 'rule', f.validation, null
      from documents d
      cross join unnest(
        ${findings.map((finding) => finding.page)}::int[],
        ${findings.map((finding) => finding.type)}::text[],
        ${findings.map((finding) => PII_DETECTOR_VALIDATION[finding.type])}::text[]
      ) as f(page_number, pattern_type, validation)
      where d.id = ${documentId} and d.org_id is not null and d.project_id is not null
      on conflict (document_id, page_number, pattern_type) do nothing
    `);
  }
  if (match.action !== "redact_artifacts" && match.pages.size > 0) {
    const pages = [...match.pages.keys()];
    await sql`delete from document_pages where document_id = ${documentId} and page_number = any(${pages}::int[])`;
    await sql`
      update document_page_states set state = 'blocked-pii', failure_reason = 'pii-policy', read_text = null, updated_at = now()
      where document_id = ${documentId} and page_number = any(${pages}::int[]) and state in ('unseen', 'failed', 'parsed')
    `;
  }
  if (match.pages.size > 0) {
    // Every deferred match path (the document map, page materialization) gets what pii-detect does after a match: the
    // titles and the map lose what matches or came from a withheld page, and a summary tree built from the unscanned
    // text stops being served (its rows and artifact are queued for removal).
    const withheldForMap: WithheldPagesForMap = merged.blocked ? "all" : new Set(merged.withheldPages);
    await scrubTitlesAndMapForPii(sql, documentId, withheldForMap, input.matches ?? (() => false));
    await withdrawSummaryTreeForPii(sql as never, documentId);
  }
  return { blocked: merged.blocked, withheldPages: merged.withheldPages };
}
