import type { Sql } from "postgres";

import { currentPerfContext } from "../lib/perf-context.js";
import { sandboxScopeStorage, type SandboxSessionScope } from "./session-context.js";
import { onUnverifiedTeardown, type CommandTeardownError } from "./teardown.js";

/**
 * Source quarantine: a content-hash denylist across the fleet (migration 0101, `quarantined_sources`).
 *
 * A command whose teardown could not be verified quarantines its worker (teardown-breaker.ts). A
 * hostile file that can do that once can do it on every worker that picks it up, so the document's
 * source hash (the server-computed `documents.source_sha256`) is recorded when it happens, and every
 * worker refuses to run a parser command for a document whose source is listed. The refusal
 * (QuarantinedSourceError) fails that document for good: no parser fallback, no strategy retry.
 *
 * Limits: a document without a source hash is not covered; two workers that start the same source
 * before the first record lands can both be quarantined; and the check runs per activity at the
 * first command of each document, not at upload.
 */

export interface QuarantinedSource {
  sourceSha256: string;
  orgId: string | null;
  workspaceId: string | null;
}

export interface SourceQuarantineStore {
  /** The quarantine record for this document's source bytes, or null if it is not listed. */
  find(documentId: string): Promise<QuarantinedSource | null>;
  /** List the document's source; null when the document has no source hash. */
  record(entry: { documentId: string; runId?: string; stage?: string; detail: string }): Promise<QuarantinedSource | null>;
}

/** A document whose source bytes defeated command teardown before: final, never retried. */
export class QuarantinedSourceError extends Error {
  constructor(readonly documentId: string, readonly sourceSha256: string) {
    super(`document ${documentId} refused: its source was quarantined after a parser command could not be torn down`);
    this.name = "QuarantinedSourceError";
  }
}

export function findQuarantinedSourceError(error: unknown): QuarantinedSourceError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof QuarantinedSourceError) return current;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
}

export function postgresSourceQuarantine(sql: Sql<Record<string, unknown>>): SourceQuarantineStore {
  const mapRow = (row: Record<string, unknown> | undefined): QuarantinedSource | null =>
    row ? { sourceSha256: String(row.source_sha256), orgId: (row.org_id as string | null) ?? null, workspaceId: (row.workspace_id as string | null) ?? null } : null;
  return {
    async find(documentId) {
      const rows = await sql`
        select q.source_sha256, q.org_id, q.workspace_id
        from documents d
        join quarantined_sources q on q.source_sha256 = d.source_sha256
        where d.id = ${documentId}
        limit 1`;
      return mapRow(rows[0]);
    },
    async record({ documentId, runId, stage, detail }) {
      const rows = await sql`
        insert into quarantined_sources (source_sha256, org_id, workspace_id, run_id, document_id, stage, detail)
        select d.source_sha256, d.org_id, d.workspace_id, ${runId ?? null}, d.id, ${stage ?? null}, ${detail.slice(0, 2000)}
        from documents d
        where d.id = ${documentId} and d.source_sha256 is not null
        on conflict (source_sha256) do update set source_sha256 = excluded.source_sha256
        returning source_sha256, org_id, workspace_id`;
      return mapRow(rows[0]);
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
  if (typeof documentId !== "string" || !documentId) {
    console.error(`[worker-quarantine] status=source-unattributed run=${runId ?? "none"} stage=${stage ?? "none"} detail=${JSON.stringify(error.message)}`);
    return;
  }
  try {
    const listed = await store.record({
      documentId,
      ...(typeof runId === "string" ? { runId } : {}),
      ...(typeof stage === "string" ? { stage } : {}),
      detail: error.message,
    });
    console.error(
      listed
        ? `[worker-quarantine] status=source-quarantined metric=source_quarantined org=${listed.orgId ?? "none"} ` +
            `workspace=${listed.workspaceId ?? "none"} run=${runId ?? "none"} document=${documentId} stage=${stage ?? "none"} ` +
            `source_sha256=${listed.sourceSha256}`
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
    check = store.find(documentId).then((listed) => {
      if (!listed) return;
      const context = currentPerfContext();
      console.error(
        `[worker-quarantine] status=source-refused org=${listed.orgId ?? "none"} workspace=${listed.workspaceId ?? "none"} ` +
          `run=${context?.runId ?? "none"} document=${documentId} source_sha256=${listed.sourceSha256}`,
      );
      throw new QuarantinedSourceError(documentId, listed.sourceSha256);
    });
    // A failed lookup is retried by the next command; a refusal stays cached.
    checks?.set(documentId, check);
    check.catch((error: unknown) => {
      if (!(error instanceof QuarantinedSourceError)) checks?.delete(documentId);
    });
  }
  await check;
}

/** Tests only. */
export function pendingSourceQuarantineRecords(): number {
  return pendingRecords.size;
}
