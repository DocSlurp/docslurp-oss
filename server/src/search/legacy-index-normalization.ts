import {
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
 *   - whose stored `embedding.normalize` is absent or boolean, and all those runs agree on the resolved value.
 * Anything else (a missing or foreign run, an empty or unreadable snapshot, a hash the run cannot reproduce,
 * disagreeing runs, documents without an identity) stays unknown and keeps failing closed.
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
};

type RunRow = { id: string; pipeline: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The run's index config and the normalization its vectors were built with, or why that cannot be proven. */
export function provenRunIndexConfig(pipeline: unknown, legacyHash: string): { config: IndexConfig } | { reason: string } {
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
  if (typeof profileDefault !== "boolean") return { reason: "run-profile-unknown" };
  const normalize = typeof rawNormalize === "boolean" ? rawNormalize : profileDefault;
  // The parsed pipeline must resolve the same way the worker resolved it.
  if ((features.embedding.normalize ?? profileDefault) !== normalize) return { reason: "run-normalize-ambiguous" };
  const derived = indexConfigOf(features);
  if (legacyIndexConfigHash(derived) !== legacyHash) return { reason: "run-config-mismatch" };
  return { config: { ...derived, normalize } };
}

/** Backfills one project. Reads are bounded by the project's documents; the only write is one row of `projects`. */
export async function backfillProjectLegacyNormalization(projectId: string, sql: SqlClient = defaultSql): Promise<LegacyNormalizationOutcome> {
  const outcome: LegacyNormalizationOutcome = { projectId, recorded: [], unprovable: [] };
  const [project] = await sql<{ org_id: string; pipeline: unknown; index_configs: unknown }[]>`
    select org_id, pipeline, index_configs from projects where id = ${projectId}
  `;
  if (!project) return outcome;
  const configs = isRecord(project.index_configs) ? project.index_configs : {};
  let currentHash: string | null = null;
  try {
    currentHash = indexConfigHash(indexConfigOf(normalizeStoredPipelineFeatures((project.pipeline ?? null) as never, `project ${projectId}`)));
  } catch {
    currentHash = null;
  }

  // Every unpurged document of the project stamped with an identity lacking a recorded normalization (including
  // superseded owners whose rows dedup copies still serve), grouped by run.
  const groups = await sql<{ hash: string; run_id: string | null; n: number }[]>`
    select d.index_config_hash as hash, d.run_id, count(*)::int as n
    from documents d
    where d.project_id = ${projectId} and d.org_id = ${project.org_id}
      and d.purged_at is null and d.index_config_hash is not null
    group by d.index_config_hash, d.run_id
  `;
  const byHash = new Map<string, Array<{ runId: string | null; n: number }>>();
  for (const group of groups) {
    if (group.hash === currentHash) continue;
    const entry = configs[group.hash];
    if (isRecord(entry) && typeof entry.normalize === "boolean") continue;
    byHash.set(group.hash, [...(byHash.get(group.hash) ?? []), { runId: group.run_id, n: group.n }]);
  }
  if (byHash.size === 0) return outcome;

  const runIds = [...new Set([...byHash.values()].flat().map((group) => group.runId).filter((id): id is string => id !== null))];
  const runs = runIds.length === 0 ? [] : await sql<RunRow[]>`
    select r.id, r.pipeline from project_runs r
    where r.id = any(${sql.array(runIds)}::text[]) and r.project_id = ${projectId} and r.org_id = ${project.org_id}
  `;
  const runById = new Map(runs.map((run) => [run.id, run]));

  const proven: Record<string, IndexConfig> = {};
  for (const [hash, members] of byHash) {
    const documents = members.reduce((sum, member) => sum + member.n, 0);
    let config: IndexConfig | null = null;
    let reason: string | null = null;
    for (const member of members) {
      const run = member.runId ? runById.get(member.runId) : undefined;
      if (!run) { reason = member.runId ? "run-missing" : "document-without-run"; break; }
      const result = provenRunIndexConfig(run.pipeline, hash);
      if ("reason" in result) { reason = result.reason; break; }
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
    if (reason || !config) outcome.unprovable.push({ hash, reason: reason ?? "no-runs", documents });
    else proven[hash] = config;
  }
  if (Object.keys(proven).length === 0) return outcome;

  // Adds only entries whose normalization is still unrecorded; concurrent writers re-evaluate against the latest row.
  const [row] = await sql<{ index_configs: unknown }[]>`
    update projects p
    set index_configs = coalesce(p.index_configs, '{}'::jsonb) || (
      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      from jsonb_each(${sql.json(JSON.parse(JSON.stringify(proven)))}::jsonb) as e
      where jsonb_typeof(p.index_configs -> e.key -> 'normalize') is distinct from 'boolean'
    )
    where p.id = ${projectId} and p.org_id = ${project.org_id}
    returning p.index_configs
  `;
  if (row) outcome.recorded = Object.keys(proven);
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
            and jsonb_typeof(p.index_configs -> d.index_config_hash -> 'normalize') is distinct from 'boolean'
        )
      order by p.id
      limit ${pageSize}
    `;
    if (page.length === 0) break;
    for (const { id } of page) {
      try {
        const outcome = await backfillProjectLegacyNormalization(id, sql);
        if (outcome.recorded.length || outcome.unprovable.length) {
          totals.projects += 1;
          totals.recorded += outcome.recorded.length;
          totals.unprovable += outcome.unprovable.length;
          log(`[index-normalization-backfill] projectId=${id} recorded=${outcome.recorded.length} unprovable=${outcome.unprovable.length}${
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

let once: Promise<unknown> | null = null;
/** Runs the backfill once per process, in the background. */
export function backfillLegacyIndexNormalizationOnce(sql: SqlClient = defaultSql): Promise<unknown> {
  once ??= backfillLegacyIndexNormalization(sql)
    .then((totals) => { if (totals.projects) console.log(`[index-normalization-backfill] done projects=${totals.projects} recorded=${totals.recorded} unprovable=${totals.unprovable}`); })
    .catch((error: unknown) => {
      once = null;
      console.error(`[index-normalization-backfill] failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  return once;
}
