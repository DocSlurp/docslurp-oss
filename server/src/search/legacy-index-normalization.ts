import {
  applyPrivateModelMode,
  embeddingProfileCatalog,
  indexConfigHash,
  indexConfigOf,
  legacyIndexConfigHash,
  normalizeStoredPipelineFeatures,
  type IndexConfig,
} from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";

/**
 * Records the normalization of vector indexes built before normalization joined the index identity, where the
 * stored data proves it, so search can serve them instead of refusing with `index_rebuild_required`.
 *
 * Before that change the worker embedded every document with its run's pipeline (`project_runs.pipeline`, the
 * snapshot the run was created with, read through `normalizeStoredPipelineFeatures`). The vectors' normalization
 * was `pipeline.embedding.normalize` when the snapshot set it, else the embedding profile's default (true for every
 * profile throughout that code's history). The document was stamped with the legacy identity
 * (`legacyIndexConfigHash`), which covers model, dimensions, chunking and vector backends but not normalization.
 *
 * A legacy identity `h` in a project is proven only when every unpurged document of that project stamped `h`:
 *   - belongs to a run that still exists in the same project and organization, with a non-empty stored pipeline,
 *   - whose derived index config hashes to exactly `h` under the legacy formula (so that run produced the stamp), and
 *   - whose stored `embedding.normalize` is absent or boolean, and all those runs agree on the resolved value,
 *   - belongs to the project's organization, and
 *   - if a partial run reused stage outputs (embeddings included) from an earlier document, every run along that
 *     reuse chain is provable the same way (same project and organization) and agrees.
 * Anything else (a missing or foreign run, an empty or unreadable snapshot, a hash the run cannot reproduce,
 * disagreeing runs, a broken reuse chain, documents without an identity) stays unknown and keeps failing closed.
 *
 * The proven entry is added to `projects.index_configs` under the legacy hash. Documents keep their stamp, so no
 * document changes index identity. The write is one conditional update of the project row that never replaces an
 * entry whose normalization is already recorded: idempotent and safe to run on every API process concurrently.
 */

export type LegacyNormalizationOutcome = {
  projectId: string;
  /** Legacy hashes now recorded with a proven normalization. */
  recorded: string[];
  /** Legacy hashes left unknown, with the first reason found. */
  unprovable: Array<{ hash: string; reason: string; documents: number }>;
  /** Unpurged documents with no identity at all: never provable, search keeps refusing them. */
  unhashed: number;
};

type RunRow = { id: string; pipeline: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The normalization a run's stored pipeline made the worker embed with, or why it cannot be proven. */
export function runNormalization(pipeline: unknown): { normalize: boolean; features: ReturnType<typeof normalizeStoredPipelineFeatures> } | { reason: string } {
  if (!isRecord(pipeline) || Object.keys(pipeline).length === 0) return { reason: "run-pipeline-missing" };
  const rawEmbedding = pipeline.embedding;
  if (rawEmbedding !== undefined && !isRecord(rawEmbedding)) return { reason: "run-embedding-unreadable" };
  const rawNormalize = rawEmbedding?.normalize;
  if (rawNormalize !== undefined && typeof rawNormalize !== "boolean") return { reason: "run-normalize-unreadable" };
  let features;
  try {
    features = normalizeStoredPipelineFeatures(pipeline as never, "legacy index normalization backfill");
  } catch {
    return { reason: "run-pipeline-unreadable" };
  }
  const profileDefault = embeddingProfileCatalog[features.embedding.profile]?.config.normalize;
  // Every profile defaulted to true while legacy identities were written; a different default today proves nothing.
  if (profileDefault !== true) return { reason: "run-profile-unknown" };
  const normalize = typeof rawNormalize === "boolean" ? rawNormalize : profileDefault;
  // The parsed pipeline must resolve the same way the worker resolved it.
  if ((features.embedding.normalize ?? profileDefault) !== normalize) return { reason: "run-normalize-ambiguous" };
  return { normalize, features };
}

/** The run's index config and the normalization its vectors were built with, or why that cannot be proven. */
export function provenRunIndexConfig(pipeline: unknown, legacyHash: string): { config: IndexConfig } | { reason: string } {
  const resolved = runNormalization(pipeline);
  if ("reason" in resolved) return resolved;
  const derived = indexConfigOf(resolved.features);
  if (legacyIndexConfigHash(derived) !== legacyHash) return { reason: "run-config-mismatch" };
  return { config: { ...derived, normalize: resolved.normalize } };
}

/** Hops followed through reused stage outputs before a document's embedding provenance counts as unknown. */
const MAX_REUSE_DEPTH = 16;

type DocRow = { id: string; hash: string | null; run_id: string | null; org_id: string | null; reused_from_document_id: string | null };

/** Backfills one project. Reads are bounded by the project's documents; the only write is one row of `projects`. */
export async function backfillProjectLegacyNormalization(projectId: string, sql: SqlClient = defaultSql): Promise<LegacyNormalizationOutcome> {
  const outcome: LegacyNormalizationOutcome = { projectId, recorded: [], unprovable: [], unhashed: 0 };
  const [project] = await sql<{ org_id: string; pipeline: unknown; index_configs: unknown }[]>`
    select org_id, pipeline, index_configs from projects where id = ${projectId}
  `;
  if (!project) return outcome;
  const configs = isRecord(project.index_configs) ? project.index_configs : {};
  let currentHash: string | null = null;
  try {
    currentHash = indexConfigHash(indexConfigOf(applyPrivateModelMode(normalizeStoredPipelineFeatures((project.pipeline ?? null) as never, `project ${projectId}`))));
  } catch {
    currentHash = null;
  }

  // Every unpurged document of the project (by project alone: search serves by project, so a document the proof
  // skipped would still be served under the entry), including superseded owners whose rows dedup copies serve.
  const docs = await sql<DocRow[]>`
    select d.id, d.index_config_hash as hash, d.run_id, d.org_id, d.reused_from_document_id
    from documents d
    where d.project_id = ${projectId} and d.purged_at is null
  `;
  const byHash = new Map<string, DocRow[]>();
  for (const doc of docs) {
    if (doc.hash === null) { outcome.unhashed += 1; continue; }
    if (doc.hash === currentHash) continue;
    const entry = configs[doc.hash];
    if (isRecord(entry) && typeof entry.normalize === "boolean") continue;
    byHash.set(doc.hash, [...(byHash.get(doc.hash) ?? []), doc]);
  }
  if (byHash.size === 0) return outcome;

  // Embedding provenance: a partial run copies a source document's stage outputs (embeddings included) and only
  // re-stamps them, so every run along the reuse chain must agree. A broken or too-deep chain is unknown.
  const sourcesOf = new Map<string, Set<string>>(); // document -> documents its outputs were reused from
  const brokenRuns = new Map<string, string>(); // document -> reusing run id whose source document is gone
  const known = new Map<string, DocRow>(docs.map((doc) => [doc.id, doc]));
  let frontier = [...byHash.values()].flat().map((doc) => doc.id);
  const visited = new Set<string>();
  const tooDeep = new Set<string>();
  for (let depth = 0; frontier.length > 0; depth += 1) {
    frontier = frontier.filter((id) => !visited.has(id));
    for (const id of frontier) visited.add(id);
    if (frontier.length === 0) break;
    if (depth >= MAX_REUSE_DEPTH) { for (const id of frontier) tooDeep.add(id); break; }
    const refs = await sql<{ document_id: string; source_id: string | null; source_run_id: string | null }[]>`
      select s.document_id, s.stats->>'reusedFromDocumentId' as source_id, s.stats->>'reusedFromRunId' as source_run_id
      from document_run_stage_states s
      where s.document_id = any(${sql.array(frontier)}::text[]) and s.stats->>'reused' = 'true'
    `;
    const next = new Set<string>();
    for (const id of frontier) {
      const own = known.get(id)?.reused_from_document_id;
      if (own) { sourcesOf.set(id, new Set([...(sourcesOf.get(id) ?? []), own])); next.add(own); }
    }
    for (const ref of refs) {
      if (!ref.source_id) { brokenRuns.set(ref.document_id, "reuse-source-unrecorded"); continue; }
      sourcesOf.set(ref.document_id, new Set([...(sourcesOf.get(ref.document_id) ?? []), ref.source_id]));
      next.add(ref.source_id);
    }
    const missing = [...next].filter((id) => !known.has(id));
    if (missing.length > 0) {
      const rows = await sql<DocRow[]>`
        select d.id, d.index_config_hash as hash, d.run_id, d.org_id, d.reused_from_document_id
        from documents d where d.id = any(${sql.array(missing)}::text[]) and d.project_id = ${projectId}
      `;
      for (const row of rows) known.set(row.id, row);
    }
    frontier = [...next].filter((id) => known.has(id));
  }

  const runIds = [...new Set([...known.values()].map((doc) => doc.run_id).filter((id): id is string => id !== null))];
  const runs = runIds.length === 0 ? [] : await sql<RunRow[]>`
    select r.id, r.pipeline from project_runs r
    where r.id = any(${sql.array(runIds)}::text[]) and r.project_id = ${projectId} and r.org_id = ${project.org_id}
  `;
  const runById = new Map(runs.map((run) => [run.id, run]));

  /** The normalization every vector of this document was embedded with, or why it is unknown. */
  const provenance = (id: string, seen = new Set<string>()): { normalize: boolean } | { reason: string } => {
    if (seen.has(id)) return { reason: "reuse-cycle" };
    seen.add(id);
    const doc = known.get(id);
    if (!doc) return { reason: "reuse-source-missing" };
    if (doc.org_id !== project.org_id) return { reason: "document-org-mismatch" };
    if (tooDeep.has(id)) return { reason: "reuse-chain-too-deep" };
    const broken = brokenRuns.get(id);
    if (broken) return { reason: broken };
    const run = doc.run_id ? runById.get(doc.run_id) : undefined;
    if (!run) return { reason: doc.run_id ? "run-missing" : "document-without-run" };
    const own = runNormalization(run.pipeline);
    if ("reason" in own) return own;
    for (const source of sourcesOf.get(id) ?? []) {
      const upstream = provenance(source, seen);
      if ("reason" in upstream) return upstream;
      if (upstream.normalize !== own.normalize) return { reason: "reuse-disagrees" };
    }
    return own;
  };

  const proven: Record<string, IndexConfig> = {};
  for (const [hash, members] of byHash) {
    let config: IndexConfig | null = null;
    let reason: string | null = null;
    for (const member of members) {
      if (member.org_id !== project.org_id) { reason = "document-org-mismatch"; break; }
      const run = member.run_id ? runById.get(member.run_id) : undefined;
      if (!run) { reason = member.run_id ? "run-missing" : "document-without-run"; break; }
      const result = provenRunIndexConfig(run.pipeline, hash);
      if ("reason" in result) { reason = result.reason; break; }
      const embedded = provenance(member.id);
      if ("reason" in embedded) { reason = embedded.reason; break; }
      if (embedded.normalize !== result.config.normalize) { reason = "reuse-disagrees"; break; }
      if (config && config.normalize !== result.config.normalize) { reason = "runs-disagree"; break; }
      config ??= result.config;
    }
    // An entry recorded before normalization was tracked must describe the same index.
    const existing = configs[hash];
    if (!reason && config && isRecord(existing)) {
      const stored = existing as unknown as IndexConfig;
      try {
        if (legacyIndexConfigHash(stored) !== hash) reason = "stored-entry-mismatch";
        else config = { ...stored, normalize: config.normalize };
      } catch {
        reason = "stored-entry-unreadable";
      }
    }
    if (reason || !config) outcome.unprovable.push({ hash, reason: reason ?? "no-runs", documents: members.length });
    else proven[hash] = config;
  }
  if (Object.keys(proven).length === 0) return outcome;

  // Adds only entries whose normalization is still unrecorded; concurrent writers re-evaluate against the latest row.
  const entries = sql.json(JSON.parse(JSON.stringify(proven)));
  const [row] = await sql<{ index_configs: Record<string, unknown> }[]>`
    update projects p
    set index_configs = coalesce(p.index_configs, '{}'::jsonb) || (
      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      from jsonb_each(${entries}::jsonb) as e
      where jsonb_typeof(p.index_configs -> e.key -> 'normalize') is distinct from 'boolean'
    )
    where p.id = ${projectId} and p.org_id = ${project.org_id}
      and exists (
        select 1 from jsonb_each(${entries}::jsonb) as e
        where jsonb_typeof(p.index_configs -> e.key -> 'normalize') is distinct from 'boolean'
      )
    returning p.index_configs
  `;
  if (row) {
    // jsonb reorders keys: compare canonically.
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
      isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v);
    outcome.recorded = Object.keys(proven).filter((hash) => canonical(row.index_configs[hash]) === canonical(JSON.parse(JSON.stringify(proven[hash]))));
  }
  return outcome;
}

/**
 * Walks every project once (keyset pages) and backfills the ones with unrecorded legacy identities. Each project is
 * its own short statement sequence; no long transaction or table lock is held.
 */
export async function backfillLegacyIndexNormalization(sql: SqlClient = defaultSql, options: { pageSize?: number; log?: (line: string) => void } = {}): Promise<{ projects: number; recorded: number; unprovable: number }> {
  const pageSize = Math.max(1, options.pageSize ?? 50);
  const log = options.log ?? ((line: string) => console.log(line));
  const totals = { projects: 0, recorded: 0, unprovable: 0 };
  let cursor = "";
  for (;;) {
    const page = await sql<{ id: string }[]>`
      select p.id from projects p
      where p.id > ${cursor}
        and exists (
          select 1 from documents d
          where d.project_id = p.id and d.purged_at is null and d.index_config_hash is not null
            and d.created_at < ${LEGACY_STAMP_CUTOFF}::timestamptz
            and jsonb_typeof(p.index_configs -> d.index_config_hash -> 'normalize') is distinct from 'boolean'
        )
      order by p.id
      limit ${pageSize}
    `;
    if (page.length === 0) break;
    for (const { id } of page) {
      try {
        const outcome = await backfillProjectLegacyNormalization(id, sql);
        if (outcome.recorded.length || outcome.unprovable.length || outcome.unhashed) {
          totals.projects += 1;
          totals.recorded += outcome.recorded.length;
          totals.unprovable += outcome.unprovable.length;
          log(`[index-normalization-backfill] projectId=${id} recorded=${outcome.recorded.length} unprovable=${outcome.unprovable.length} unhashed=${outcome.unhashed}${
            outcome.unprovable.map((u) => ` ${u.hash}:${u.reason}:${u.documents}`).join("")}`);
        }
      } catch (error) {
        console.error(`[index-normalization-backfill] projectId=${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    cursor = page[page.length - 1]!.id;
  }
  return totals;
}

/**
 * Candidate selection only (the proof still reads every document): documents created after this were stamped by
 * code that records normalization, so once it passes, boots stop walking projects that cannot need the backfill.
 * Generous on purpose: it is well after every API and worker that wrote legacy identities was replaced.
 */
export const LEGACY_STAMP_CUTOFF = "2026-11-18T00:00:00Z";

let once: Promise<unknown> | null = null;
/** Runs the backfill once per process, in the background; a failed pass retries with backoff (bounded). */
export function backfillLegacyIndexNormalizationOnce(sql: SqlClient = defaultSql, attempt = 0): Promise<unknown> {
  once ??= backfillLegacyIndexNormalization(sql)
    .then((totals) => { if (totals.projects) console.log(`[index-normalization-backfill] done projects=${totals.projects} recorded=${totals.recorded} unprovable=${totals.unprovable}`); })
    .catch((error: unknown) => {
      console.error(`[index-normalization-backfill] failed attempt=${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt + 1 >= 8) return;
      const timer = setTimeout(() => { once = null; void backfillLegacyIndexNormalizationOnce(sql, attempt + 1); }, Math.min(30_000 * 2 ** attempt, 15 * 60_000));
      timer.unref?.();
    });
  return once;
}
