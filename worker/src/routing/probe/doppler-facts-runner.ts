/**
 * The v2 page router's probe on a sandboxed deployment: Doppler page facts the PDF VM already measured, read back from the
 * document's stored canonical facts (ROUTING_PAGE_FACTS_SLOT, written by extract-markdown in DOCSLURP_DOPPLER_PAGE_FACTS=use).
 *
 * Rules:
 * - Never opens the PDF: no native binding, no render, no byte scan of the source. Encryption comes from the facts' doc line.
 * - The stored lines are re-validated by the strict reader (parseDopplerPageFacts), bounded by the host's own measured page
 *   count; storage is not trusted to hold what extract-markdown wrote.
 * - Anything short of complete, valid facts is `unavailable`: the router then writes no plan and the document keeps the
 *   existing (v3) routing. Missing or malformed facts never authorize a model read and never raise a charge.
 */
import { StorageObjectTooLargeError } from "../../tools/storage.js";
import { dopplerPageFactsByteBudget, parseDopplerPageFacts, type DopplerPageFactsDocument } from "../../lib/doppler-page-facts.js";
import type { ProbeRow } from "../page-input.js";
import { probeRowsFromDopplerFacts } from "./doppler-facts.js";

/** Document artifact slot holding the canonical facts lines (dopplerPageFactsJsonl) the router reads. */
export const ROUTING_PAGE_FACTS_SLOT = "routing-page-facts";

/** The one storage key a document's routing facts live at, under its run's artifact root (runArtifactRoot). */
export function routingPageFactsKey(artifactRoot: string, documentId: string): string {
  return `${artifactRoot}/routing-page-facts/${documentId}.jsonl`;
}

export type FactsProbeUnavailable =
  | "no-host-page-count"
  | "facts-missing"
  | "facts-oversized"
  | "facts-read-failed"
  | `facts-refused:${string}`
  | "facts-unreadable-document"
  | "facts-incomplete"
  | "facts-all-pages-failed";

export type FactsProbeResult =
  | { status: "ok"; rows: ProbeRow[]; locked: boolean; pagesKnown: number; pagesFailed: number; linesDropped: number }
  | { status: "unavailable"; reason: FactsProbeUnavailable; detail?: string };

export type FactsProbeRunner = (args: {
  documentId: string;
  /** The host's measured page count (documents.page_count when page_count_source is not `assumed`); null when unknown. */
  pageCount: number | null;
  signal?: AbortSignal;
}) => Promise<FactsProbeResult>;

/** Reads the stored facts for a document, at most `maxBytes`; null when none are stored. */
export type FactsReader = (args: { documentId: string; maxBytes: number; signal?: AbortSignal }) => Promise<Uint8Array | null>;

/** Treat a doc line that says a user password is required as locked, whether or not Doppler also set `locked`. */
function lockedDoc(facts: DopplerPageFactsDocument): boolean {
  return facts.doc.locked === true || facts.doc.encryption === "user-password-required";
}

export function createDopplerFactsProbeRunner(read: FactsReader): FactsProbeRunner {
  return async ({ documentId, pageCount, signal }) => {
    if (pageCount === null || !Number.isSafeInteger(pageCount) || pageCount < 1) return { status: "unavailable", reason: "no-host-page-count" };
    const maxBytes = dopplerPageFactsByteBudget(pageCount);
    let bytes: Uint8Array | null;
    try {
      bytes = await read({ documentId, maxBytes, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof StorageObjectTooLargeError) return { status: "unavailable", reason: "facts-oversized" };
      return { status: "unavailable", reason: "facts-read-failed", detail: error instanceof Error ? error.message.slice(0, 200) : undefined };
    }
    if (!bytes || bytes.byteLength === 0) return { status: "unavailable", reason: "facts-missing" };
    if (bytes.byteLength > maxBytes) return { status: "unavailable", reason: "facts-oversized" };
    const parsed = parseDopplerPageFacts(bytes, { pageCount });
    if (!parsed.ok) return { status: "unavailable", reason: `facts-refused:${parsed.reason}` };
    const { facts } = parsed;
    const summary = { pagesKnown: facts.summary.pagesKnown, pagesFailed: facts.summary.pagesFailed, linesDropped: facts.summary.linesDropped };
    if (lockedDoc(facts)) {
      return { status: "ok", rows: probeRowsFromDopplerFacts({ doc: { ...facts.doc, locked: true }, pages: new Map() }, pageCount), locked: true, ...summary };
    }
    if (facts.doc.error) return { status: "unavailable", reason: "facts-unreadable-document" };
    // Every page the host counted must be known (a failed page is known, as the probe's failed row): a partial plan would
    // leave pages the router never saw.
    if (facts.pages.size !== pageCount) return { status: "unavailable", reason: "facts-incomplete", detail: `${facts.pages.size}/${pageCount}` };
    // Facts that know nothing about any page are no facts: v3 decides, not a row of failed pages.
    if (facts.summary.pagesFailed >= pageCount) return { status: "unavailable", reason: "facts-all-pages-failed" };
    const rows = probeRowsFromDopplerFacts(facts, pageCount);
    if (rows.length !== pageCount) return { status: "unavailable", reason: "facts-incomplete", detail: `${rows.length}/${pageCount}` };
    // Facts rows never carry a thumbnail; strip one defensively so nothing downstream reads a host path.
    return { status: "ok", rows: rows.map(({ thumbnail: _thumbnail, ...row }) => row), locked: false, ...summary };
  };
}
