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
      and (${r}.pipeline->>'quality' in ('good', 'smart', 'smartest') or coalesce((${r}.pipeline->>'visionFallback')::boolean, false)))`;
}

/**
 * The run's stored quality word (`fast` | `auto`), for queries that read it beside the run's `ladder` (which holds the
 * level of an `auto` run): a stored `fast` (text layer only) stays `fast`; every other word, the retired `good` and the
 * level names included, is `auto`; `parserPlaybook: fast` on rows older than `quality` is `fast`.
 */
export function runLegacyQualitySql(runAlias: string): string {
  const r = alias(runAlias);
  return `case
    when ${r}.pipeline->>'quality' = 'fast' then 'fast'
    when ${r}.pipeline->>'quality' is null and ${r}.pipeline->>'parserPlaybook' = 'fast' then 'fast'
    else 'auto'
  end`;
}

/**
 * The run's pricing profile (billing.ts PIPELINE_PROFILE_IDS) as `fast` | `fastest` | `smartest`, for queries that group
 * history by quality: `fast` when it read no page (a stored `fast`, or the ladder's `fast` rung), `smartest` when its
 * ladder allowed the vision rung (or the retired `good`; runs stamped before the ladder default moved read `intelligent`
 * when the rung is unset), else `fastest`.
 */
export function runQualityProfileSql(runAlias: string): string {
  const r = alias(runAlias);
  return `case
    when ${r}.pipeline->>'quality' = 'fast' or (${r}.pipeline->>'quality' is null and ${r}.pipeline->>'parserPlaybook' = 'fast') then 'fast'
    when ${r}.pipeline->>'quality' = 'good' or ${r}.pipeline->'vision'->>'forceAllPages' = 'true' then 'smartest'
    when coalesce(${r}.pipeline->'ladder'->>'maxRung', 'intelligent') = 'fast' then 'fast'
    when coalesce(${r}.pipeline->'ladder'->>'maxRung', 'intelligent') = 'intelligent' then 'smartest'
    else 'fastest'
  end`;
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

/**
 * True when the project row keeps page images: its `pageImages` (a non-boolean stored value reads as the default, on,
 * never an error), or Smartest, which always keeps them (an `auto` row on the intelligent rung, or a row still on the
 * retired `good`).
 */
export function pageImagesOnSql(projectAlias: string): string {
  const p = alias(projectAlias);
  return `((case when jsonb_typeof(${p}.pipeline->'pageImages') = 'boolean' then (${p}.pipeline->'pageImages')::boolean else true end)
    or (coalesce(${p}.pipeline->>'quality', 'auto') = 'auto' and ${p}.pipeline->'ladder'->>'maxRung' = 'intelligent')
    or coalesce(${p}.pipeline->>'quality' = 'good', false))`;
}

/** True when the row is still on the retired `good` quality (before migration 0199 moved it to Smartest). */
export function retiredGoodQualitySql(alias_: string): string {
  return `coalesce(${alias(alias_)}.pipeline->>'quality' = 'good', false)`;
}
