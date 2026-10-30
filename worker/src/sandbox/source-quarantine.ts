import type { Sql } from "postgres";

import { currentPerfContext } from "../lib/perf-context.js";
import { sandboxScopeStorage, type SandboxSessionScope } from "./session-context.js";
import { SourceRefusalError, stagedSourceSha256 } from "./source-integrity.js";
import { onUnverifiedTeardown, type CommandTeardownError } from "./teardown.js";

/**
 * Source quarantine: a content-hash denylist across the fleet (migration 0101, `quarantined_sources`).
 *
 * A command whose teardown could not be verified quarantines its worker (teardown-breaker.ts). A
 * hostile file that can do that once can do it on every worker that picks it up, so when the failure
 * is attributable to the command (CommandTeardownError.attributable: its stdio held open after its
 * own processes were gone) the document's source hash (the server-computed `documents.source_sha256`)
 * is recorded, and every worker refuses to run a parser command for a document whose source is
 * listed. The refusal (QuarantinedSourceError) fails that document for good: no parser fallback, no
 * strategy retry. Timing and host causes (processes not reaped within the verify bound, a refused
 * provider) never list a source. Every row expires after WORKER_SOURCE_QUARANTINE_TTL_HOURS
 * (default 168, 7 days), so a false positive heals itself; a later attributable failure extends it.
 * Every organization whose document hit the row (teardown or refusal) is kept for attribution.
 *
 * Hashes are the staged ones: the bytes this worker downloaded and hashed (source-integrity.ts),
 * which must equal the server's `documents.source_sha256` or the document is refused before any
 * command. So a source swapped after upload can neither list another file's hash nor hide listed
 * bytes behind a fresh one. A document without a server hash is keyed by its staged hash.
 *
 * Organization breaker: every unverified teardown with a document (attributable or not: each one
 * costs a worker) is also counted against the document's organization (`org_teardown_failures`).
 * Once an organization reaches WORKER_ORG_TEARDOWN_LIMIT (default 3) within
 * WORKER_ORG_TEARDOWN_WINDOW_HOURS (default 24), every worker refuses its parser work
 * (QuarantinedOrgError, final, `[worker-quarantine] status=org-refused`), so byte-varied files
 * cannot walk the fleet one worker at a time. The window slides: the refusal lifts by itself.
 *
 * Limits: two workers that start the same source before the first record lands can both be
 * quarantined; and the check runs per activity at the first command of each document, not at upload.
 */

export interface QuarantinedSource {
  sourceSha256: string;
  orgId: string | null;
  workspaceId: string | null;
}

export interface SourceQuarantineStore {
  /**
   * The unexpired quarantine record for this document's source bytes (`stagedSha256` when this worker
   * staged them, else the server's hash), or null if it is not listed.
   */
  find(documentId: string, stagedSha256?: string | null): Promise<QuarantinedSource | null>;
  /** List the document's source (staged hash, else the server's) for `ttlHours`; null when neither is known. */
  record(entry: {
    documentId: string;
    stagedSha256?: string | null;
    runId?: string;
    stage?: string;
    detail: string;
    ttlHours: number;
  }): Promise<QuarantinedSource | null>;
  /** Note that the document was refused (its organization joins the row's attribution). */
  noteRefusal(entry: { documentId: string; sourceSha256: string }): Promise<void>;
  /** Count a teardown failure against the document's organization; its failures within the window. */
  recordOrgFailure(entry: {
    documentId: string;
    runId?: string;
    stage?: string;
    attributable: boolean;
    detail: string;
    windowHours: number;
  }): Promise<{ orgId: string; count: number } | null>;
  /** The document's organization and its failures within the window, or null if it has none. */
  orgFailures(documentId: string, windowHours: number): Promise<{ orgId: string; count: number } | null>;
}

const DEFAULT_TTL_HOURS = 168;

/** How long a listed source stays refused (WORKER_SOURCE_QUARANTINE_TTL_HOURS, default 7 days). */
export function sourceQuarantineTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WORKER_SOURCE_QUARANTINE_TTL_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_HOURS;
}

/** A document whose source bytes defeated command teardown before: final, never retried. */
export class QuarantinedSourceError extends SourceRefusalError {
  constructor(documentId: string, readonly sourceSha256: string) {
    super(`document ${documentId} refused: its source was quarantined after a parser command could not be torn down`, documentId);
    this.name = "QuarantinedSourceError";
  }
}

/** A document of an organization whose parser work defeated teardown too often: final, never retried. */
export class QuarantinedOrgError extends SourceRefusalError {
  constructor(documentId: string, readonly orgId: string, readonly failures: number) {
    super(
      `document ${documentId} refused: parser work for this organization is paused after repeated sandbox teardown failures`,
      documentId,
    );
    this.name = "QuarantinedOrgError";
  }
}

const DEFAULT_ORG_LIMIT = 3;
const DEFAULT_ORG_WINDOW_HOURS = 24;

/** Teardown failures an organization may cause within the window before its parser work is refused. */
export function orgTeardownLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WORKER_ORG_TEARDOWN_LIMIT);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_ORG_LIMIT;
}

export function orgTeardownWindowHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WORKER_ORG_TEARDOWN_WINDOW_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ORG_WINDOW_HOURS;
}

/**
 * Any refusal of a document for its source or organization (quarantined source, quarantined
 * organization, source changed after upload): final, no fallback, no retry.
 */
export function findQuarantinedSourceError(error: unknown): SourceRefusalError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof SourceRefusalError) return current;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
}

export function postgresSourceQuarantine(sql: Sql<Record<string, unknown>>): SourceQuarantineStore {
  const countOrgFailures = async (orgId: string, windowHours: number) => {
    const [row] = await sql`
      select count(*)::int as count from org_teardown_failures
      where org_id = ${orgId} and created_at > now() - ${windowHours}::double precision * interval '1 hour'`;
    return { orgId, count: Number(row?.count ?? 0) };
  };
  const mapRow = (row: Record<string, unknown> | undefined): QuarantinedSource | null =>
    row ? { sourceSha256: String(row.source_sha256), orgId: (row.org_id as string | null) ?? null, workspaceId: (row.workspace_id as string | null) ?? null } : null;
  return {
    async find(documentId, stagedSha256 = null) {
      const rows = await sql`
        select q.source_sha256, q.org_id, q.workspace_id
        from documents d
        join quarantined_sources q on q.source_sha256 = coalesce(${stagedSha256}::text, d.source_sha256)
        where d.id = ${documentId} and q.expires_at > now()
        limit 1`;
      return mapRow(rows[0]);
    },
    async record({ documentId, stagedSha256 = null, runId, stage, detail, ttlHours }) {
      // The first attribution is kept; a later failure (another worker raced it, or the row expired)
      // extends the expiry and adds its organization.
      const rows = await sql`
        insert into quarantined_sources as q (
          source_sha256, org_id, workspace_id, run_id, document_id, stage, detail, expires_at,
          org_ids, last_org_id, last_document_id
        )
        select coalesce(${stagedSha256}::text, d.source_sha256), d.org_id, d.workspace_id, ${runId ?? null}, d.id, ${stage ?? null},
          ${detail.slice(0, 2000)}, now() + ${ttlHours}::double precision * interval '1 hour',
          case when d.org_id is null then '{}'::text[] else array[d.org_id] end, d.org_id, d.id
        from documents d
        where d.id = ${documentId} and coalesce(${stagedSha256}::text, d.source_sha256) is not null
        on conflict (source_sha256) do update set
          expires_at = greatest(q.expires_at, excluded.expires_at),
          org_ids = case when excluded.last_org_id is null or excluded.last_org_id = any(q.org_ids) then q.org_ids
                         else q.org_ids || excluded.last_org_id end,
          last_org_id = excluded.last_org_id,
          last_document_id = excluded.last_document_id,
          last_seen_at = now(),
          teardown_count = q.teardown_count + 1
        returning source_sha256, org_id, workspace_id`;
      return mapRow(rows[0]);
    },
    async noteRefusal({ documentId, sourceSha256 }) {
      await sql`
        update quarantined_sources q set
          org_ids = case when d.org_id is null or d.org_id = any(q.org_ids) then q.org_ids else q.org_ids || d.org_id end,
          last_org_id = d.org_id,
          last_document_id = d.id,
          last_seen_at = now(),
          refused_count = q.refused_count + 1
        from documents d
        where q.source_sha256 = ${sourceSha256} and d.id = ${documentId}
          -- A hashed document's bytes are its server hash (staging refuses anything else); an
          -- unhashed one was found by its staged hash.
          and (d.source_sha256 is null or d.source_sha256 = q.source_sha256)`;
    },
    async recordOrgFailure({ documentId, runId, stage, attributable, detail, windowHours }) {
      const [inserted] = await sql`
        insert into org_teardown_failures (org_id, document_id, run_id, stage, attributable, detail)
        select d.org_id, d.id, ${runId ?? null}, ${stage ?? null}, ${attributable}, ${detail.slice(0, 2000)}
        from documents d
        where d.id = ${documentId} and d.org_id is not null
        returning org_id`;
      if (!inserted) return null;
      return await countOrgFailures(String(inserted.org_id), windowHours);
    },
    async orgFailures(documentId, windowHours) {
      const [row] = await sql`
        select d.org_id, count(f.id)::int as count
        from documents d
        join org_teardown_failures f on f.org_id = d.org_id
          and f.created_at > now() - ${windowHours}::double precision * interval '1 hour'
        where d.id = ${documentId}
        group by d.org_id`;
      return row ? { orgId: String(row.org_id), count: Number(row.count) } : null;
    },
  };
}

let configured: SourceQuarantineStore | null = null;
let unsubscribe: (() => void) | null = null;
const pendingRecords = new Set<Promise<void>>();
/** Documents already admitted in an activity: one lookup per document per activity. */
const admitted = new WeakMap<SandboxSessionScope, Map<string, Promise<void>>>();

/**
 * Use `store` for admission checks and record every unverified teardown's document in it.
 * Without a configured store (tests, CLIs) nothing is checked or recorded. Returns an unconfigure.
 */
export function configureSourceQuarantine(store: SourceQuarantineStore | null): () => void {
  unsubscribe?.();
  unsubscribe = null;
  configured = store;
  if (store) {
    unsubscribe = onUnverifiedTeardown((_count, error) => {
      const pending = quarantineSourceOf(store, error);
      pendingRecords.add(pending);
      void pending.finally(() => pendingRecords.delete(pending));
    });
  }
  return () => configureSourceQuarantine(null);
}

async function quarantineSourceOf(store: SourceQuarantineStore, error: CommandTeardownError): Promise<void> {
  const { run_id: runId, document_id: documentId, stage } = error.attribution;
  if (typeof documentId === "string" && documentId) await countOrgFailure(store, error, documentId);
  if (!error.attributable) {
    // Timing or a host cause, not the bytes: the worker quarantines itself, the source stays admitted.
    console.error(
      `[worker-quarantine] status=source-not-listed reason=unattributable run=${runId ?? "none"} ` +
        `document=${documentId ?? "none"} stage=${stage ?? "none"} detail=${JSON.stringify(error.message)}`,
    );
    return;
  }
  if (typeof documentId !== "string" || !documentId) {
    console.error(`[worker-quarantine] status=source-unattributed run=${runId ?? "none"} stage=${stage ?? "none"} detail=${JSON.stringify(error.message)}`);
    return;
  }
  try {
    const listed = await store.record({
      documentId,
      stagedSha256: stagedSourceSha256(documentId),
      ...(typeof runId === "string" ? { runId } : {}),
      ...(typeof stage === "string" ? { stage } : {}),
      detail: error.message,
      ttlHours: sourceQuarantineTtlHours(),
    });
    console.error(
      listed
        ? `[worker-quarantine] status=source-quarantined metric=source_quarantined org=${listed.orgId ?? "none"} ` +
            `workspace=${listed.workspaceId ?? "none"} run=${runId ?? "none"} document=${documentId} stage=${stage ?? "none"} ` +
            `source_sha256=${listed.sourceSha256} ttl_hours=${sourceQuarantineTtlHours()}`
        : `[worker-quarantine] status=source-unhashed run=${runId ?? "none"} document=${documentId} stage=${stage ?? "none"} ` +
            "detail=document has no source hash; its source cannot be denylisted",
    );
  } catch (recordError) {
    console.error(
      `[worker-quarantine] status=source-record-failed run=${runId ?? "none"} document=${documentId} ` +
        `error=${JSON.stringify(recordError instanceof Error ? recordError.message : String(recordError))}`,
    );
  }
}

async function countOrgFailure(store: SourceQuarantineStore, error: CommandTeardownError, documentId: string): Promise<void> {
  const { run_id: runId, stage } = error.attribution;
  try {
    const counted = await store.recordOrgFailure({
      documentId,
      ...(typeof runId === "string" ? { runId } : {}),
      ...(typeof stage === "string" ? { stage } : {}),
      attributable: error.attributable,
      detail: error.message,
      windowHours: orgTeardownWindowHours(),
    });
    if (counted && counted.count >= orgTeardownLimit()) {
      // Alertable: this organization's parser work is now refused on every worker.
      console.error(
        `[worker-quarantine] status=org-breaker-open metric=org_teardown_breaker_open org=${counted.orgId} ` +
          `failures=${counted.count} limit=${orgTeardownLimit()} window_hours=${orgTeardownWindowHours()} document=${documentId}`,
      );
    }
  } catch (recordError) {
    console.error(
      `[worker-quarantine] status=org-record-failed run=${runId ?? "none"} document=${documentId} ` +
        `error=${JSON.stringify(recordError instanceof Error ? recordError.message : String(recordError))}`,
    );
  }
}

/** Wait (bounded) for quarantine records still being written; called before a latched activity ends. */
export async function flushSourceQuarantine(timeoutMs = 5_000): Promise<void> {
  if (pendingRecords.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...pendingRecords]),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
  ]);
  clearTimeout(timer);
}

/**
 * Refuse a parser command for a document whose source is quarantined. Looks up each document once
 * per activity; a lookup failure propagates (no command runs on an unchecked source).
 */
export async function admitCommandSource(): Promise<void> {
  const store = configured;
  const documentId = currentPerfContext()?.documentId;
  if (!store || !documentId) return;
  const scope = sandboxScopeStorage.getStore();
  let checks = scope ? admitted.get(scope) : undefined;
  if (scope && !checks) admitted.set(scope, (checks = new Map()));
  let check = checks?.get(documentId);
  if (!check) {
    check = Promise.all([
      store.find(documentId, stagedSourceSha256(documentId)),
      store.orgFailures(documentId, orgTeardownWindowHours()),
    ]).then(async ([listed, org]) => {
      if (org && org.count >= orgTeardownLimit()) {
        console.error(
          `[worker-quarantine] status=org-refused metric=org_parser_refused org=${org.orgId} failures=${org.count} ` +
            `limit=${orgTeardownLimit()} run=${currentPerfContext()?.runId ?? "none"} document=${documentId}`,
        );
        throw new QuarantinedOrgError(documentId, org.orgId, org.count);
      }
      if (!listed) return;
      const context = currentPerfContext();
      console.error(
        `[worker-quarantine] status=source-refused org=${listed.orgId ?? "none"} workspace=${listed.workspaceId ?? "none"} ` +
          `run=${context?.runId ?? "none"} document=${documentId} source_sha256=${listed.sourceSha256}`,
      );
      // Attribution only: a failure to note it never admits the document.
      await store.noteRefusal({ documentId, sourceSha256: listed.sourceSha256 }).catch((noteError: unknown) =>
        console.error(
          `[worker-quarantine] status=refusal-note-failed document=${documentId} ` +
            `error=${JSON.stringify(noteError instanceof Error ? noteError.message : String(noteError))}`,
        ),
      );
      throw new QuarantinedSourceError(documentId, listed.sourceSha256);
    });
    // A failed lookup is retried by the next command; a refusal stays cached.
    checks?.set(documentId, check);
    check.catch((error: unknown) => {
      if (!(error instanceof SourceRefusalError)) checks?.delete(documentId);
    });
  }
  await check;
}

/** Tests only. */
export function pendingSourceQuarantineRecords(): number {
  return pendingRecords.size;
}
