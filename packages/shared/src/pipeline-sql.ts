/**
 * The only raw SQL readers of extraction keys in a stored pipeline (`projects.pipeline`, `project_runs.pipeline`).
 * Everything else reads a run's stamped `pipeline.effective` through these, or parses the pipeline in TypeScript
 * (`parseStoredPipelineFeatures`, which reads both shapes). `server/src/__tests__/raw-pipeline-readers.test.ts` fails
 * on a raw read of a retired extraction key (`visionFallback`, `quality`, `figures`, `chartExport`, `visuals`)
 * anywhere else.
 *
 * Each helper returns SQL text for a table alias; callers embed it with their client's `unsafe`. The alias must be a
 * plain identifier (checked), never request input.
 */

function alias(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`pipeline-sql: invalid table alias ${JSON.stringify(name)}`);
  return name;
}

/**
 * True when the run may send pages to OCR or a model reader: its stamped `effective.readsPages`, else (runs stamped
 * before this release) its legacy fields: not `fast`, and `good` or `visionFallback` on (unset counts as off, as the
 * autoscaler always read it).
 */
export function runReadsPagesSql(runAlias: string): string {
  const r = alias(runAlias);
  return `coalesce((${r}.pipeline->'effective'->>'readsPages')::boolean,
    coalesce(${r}.pipeline->>'quality', 'auto') not in ('fast', 'fastest')
      and (${r}.pipeline->>'quality' in ('good', 'smart') or coalesce((${r}.pipeline->>'visionFallback')::boolean, false)))`;
}

/**
 * The run's quality in the deprecated words (`fast` | `auto` | `good`), for queries that group history by quality:
 * the stamp, else a new-shape word, else the legacy keys (`parserPlaybook`, `vision.forceAllPages` before `quality`).
 */
export function runLegacyQualitySql(runAlias: string): string {
  const r = alias(runAlias);
  const word = (expr: string) => `case ${expr} when 'fastest' then 'fast' when 'balanced' then 'auto' when 'smart' then 'good' else null end`;
  return `coalesce(
    ${word(`${r}.pipeline->'effective'->>'quality'`)},
    ${word(`${r}.pipeline->>'quality'`)},
    case when ${r}.pipeline->>'quality' in ('fast', 'auto', 'good') then ${r}.pipeline->>'quality' else null end,
    case
      when ${r}.pipeline->'vision'->>'forceAllPages' = 'true' or ${r}.pipeline->>'parserPlaybook' = 'review-grade' then 'good'
      when ${r}.pipeline->>'parserPlaybook' = 'fast' then 'fast'
      else 'auto'
    end
  )`;
}

/**
 * The project's (or run's) PDF figure pass is on: `figures` not off in any legacy shape (`false`, `"off"`,
 * `{ enabled: false }`) and `visuals` not `none` (a new-shape row). Fails closed on malformed shapes.
 */
export function figuresOnSqlText(pipelineAlias: string): string {
  const p = alias(pipelineAlias);
  return `(coalesce(${p}.pipeline -> 'figures', 'true'::jsonb) not in ('false'::jsonb, '"off"'::jsonb)
    and coalesce(${p}.pipeline -> 'figures' ->> 'enabled', 'true') <> 'false'
    and coalesce(${p}.pipeline ->> 'visuals', '') <> 'none')`;
}

/** A run's stamped chart tier (`off` | `free` | `models`), or null; a new-shape `visuals` maps onto the tier. */
export function runChartTierSql(runAlias: string): string {
  const r = alias(runAlias);
  return `coalesce(${r}.pipeline -> 'chartExport' ->> 'tier',
    case ${r}.pipeline ->> 'visuals' when 'charts-ai' then 'models' when 'charts' then 'free' when 'figures' then 'off' when 'none' then 'off' else null end)`;
}
