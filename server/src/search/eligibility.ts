import { sql } from "../db.js";
import type { SqlFragment } from "../lib/sql-fragments.js";
import { effectiveFleetCapabilitiesSync } from "../services/worker-fleet.js";

/**
 * Which document versions search may serve.
 *
 * A document is fully indexed once the index stage flips it to `completed`
 * (vectors registered, the supersede trigger swapped older versions out in the
 * same transaction). With early lexical search on, keyword search also serves a
 * document whose chunks are all materialized (`lexical_searchable_at`, stamped
 * by the embed stage) while later stages still run, provided:
 *
 * - it is not terminal-unsearchable (failed, cancelled, PII-blocked) and not
 *   superseded;
 * - its run is still live (queued or processing, not cancelled or
 *   dead-lettered), so a run that dies mid-flight stops serving its partial
 *   documents;
 * - no other live version of the same source could be served instead: no
 *   completed sibling (a reprocess keeps serving the old version until the
 *   atomic swap at completion) and no newer early sibling. Exactly one version
 *   per canonical source is ever searchable.
 *
 * Vectors are only written by the index stage, so vector search stays on
 * completed documents; early documents are keyword-only until then.
 */

/** Statuses a pipeline never serves from, even with materialized chunks. */
const UNSERVABLE_STATUSES = sql`('completed', 'failed', 'cancelled', 'pii_blocked')`;

/** Statuses that can never be served, whatever else is materialized. */
const TERMINAL_UNSEARCHABLE_STATUSES = sql`('failed', 'cancelled', 'pii_blocked')`;

function truthy(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return null;
}

/**
 * SEARCH_EARLY_LEXICAL: serve keyword search from documents whose chunks are
 * materialized before the index stage completes. An explicit value wins; unset
 * it is on outside production.
 */
export function searchEarlyLexicalEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const explicit = truthy(env.SEARCH_EARLY_LEXICAL ?? "");
  if (explicit !== null) return explicit;
  return env.NODE_ENV !== "production";
}

/**
 * SEARCH_EARLY_LEXICAL as search applies it: configured on, and every worker
 * stamps lexical_searchable_at (search.early-lexical, services/worker-fleet.ts).
 * A stale or unknown fleet view serves fully indexed documents only.
 */
export function searchEarlyLexicalEffective(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!searchEarlyLexicalEnabled(env)) return false;
  const capabilities = effectiveFleetCapabilitiesSync(undefined, env);
  return capabilities === null || capabilities.has("search.early-lexical");
}

type DocumentAlias = "d" | "document" | "docs";

function column(alias: DocumentAlias, name: string): SqlFragment {
  return sql`${sql(alias)}.${sql(name)}`;
}

/** Fully indexed and current: vectors and keyword search both serve it. */
export function fullyIndexedDocument(alias: DocumentAlias = "d"): SqlFragment {
  return sql`(${column(alias, "status")} = 'completed' and ${column(alias, "superseded_at")} is null)`;
}

/**
 * The run is still queued or processing, not cancelled or dead-lettered.
 *
 * A scalar subquery, not `exists`: Postgres may rewrite a correlated `exists`
 * into a hashed subplan that scans every live run across all tenants on each
 * search. This form stays a primary-key probe per early document.
 */
function liveRun(runId: SqlFragment): SqlFragment {
  return sql`coalesce((
    select live_run.status in ('queued', 'processing')
      and coalesce(live_run.control_state, '') not in ('cancelled', 'cancel_requested', 'dead-letter')
    from workspace_runs live_run
    where live_run.id = ${runId}
  ), false)`;
}

/**
 * An in-progress version that may serve partial results: not terminal, not
 * superseded, its run still live, and no other live version of its source
 * that should be served instead.
 */
export function servableInProgressVersion(alias: DocumentAlias = "d"): SqlFragment {
  return sql`(
    ${column(alias, "superseded_at")} is null
    and coalesce(${column(alias, "status")}, '') not in ${UNSERVABLE_STATUSES}
    and ${liveRun(column(alias, "run_id"))}
    and not exists (
      select 1 from documents sibling
      where ${column(alias, "canonical_id")} is not null
        and sibling.workspace_id = ${column(alias, "workspace_id")}
        and sibling.canonical_id = ${column(alias, "canonical_id")}
        and sibling.id <> ${column(alias, "id")}
        and sibling.superseded_at is null
        and (
          sibling.status = 'completed'
          or (
            sibling.lexical_searchable_at is not null
            and coalesce(sibling.status, '') not in ${UNSERVABLE_STATUSES}
            and (sibling.created_at, sibling.id) > (${column(alias, "created_at")}, ${column(alias, "id")})
            and ${liveRun(sql`sibling.run_id`)}
          )
        )
    )
  )`;
}

/** Chunks materialized ahead of completion and servable to keyword search. */
export function earlyLexicalDocument(
  alias: DocumentAlias = "d",
  enabled: boolean = searchEarlyLexicalEffective(),
): SqlFragment {
  if (!enabled) return sql`false`;
  return sql`(${column(alias, "lexical_searchable_at")} is not null and ${servableInProgressVersion(alias)})`;
}

/** Keyword (chunk FTS) eligibility: fully indexed, or early lexical when enabled. */
export function lexicalSearchableDocument(
  alias: DocumentAlias = "d",
  enabled: boolean = searchEarlyLexicalEffective(),
): SqlFragment {
  if (!enabled) return fullyIndexedDocument(alias);
  return sql`(${fullyIndexedDocument(alias)} or ${earlyLexicalDocument(alias, true)})`;
}

/**
 * A document deferred indexing may locate pages in or materialize pages of:
 * current, not purged, and not terminal-unsearchable. Materializing spends
 * credits, so it must never target a document search could not serve.
 */
export function deferredCandidateDocument(alias: DocumentAlias = "d"): SqlFragment {
  return sql`(
    ${column(alias, "superseded_at")} is null
    and ${column(alias, "purged_at")} is null
    and coalesce(${column(alias, "status")}, '') not in ${TERMINAL_UNSEARCHABLE_STATUSES}
  )`;
}
