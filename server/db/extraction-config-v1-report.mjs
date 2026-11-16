#!/usr/bin/env node
// Dry run of migration 0183 (extraction config v1): counts what it would change, changes nothing.
//
//   DATABASE_URL=postgres://... node server/db/extraction-config-v1-report.mjs [--ids] [--json]
//
// Runs the migration file's own functions (between `report:functions-begin` and `report:functions-end`) as temporary
// functions (pg_temp) inside a transaction that is rolled back, so the counts come from exactly the code the migration
// runs. Needs only SELECT on projects and document_extraction_levels and the TEMP privilege. Reports:
//
// - q1: `visionFallback: false` with `auto` (or no quality) -> `balanced`, which turns rescue reads on (a raise, Q1;
//   owner-approved, a large count pauses the production migration for confirmation);
// - q3: `figureResume: off` / `manual` (automatic resume for new runs; resumable levels blocked);
// - q11: `figures: false` with a chart tier (`free`/`models`) -> `visuals: none` (their charts stop, a lowering);
// - lowered quality / visuals: combinations the new validators refuse under a restricted privacy mode (lowerings);
// - figure levels the migration blocks (`resume-off`).
//
// `--ids` adds the affected project ids per category (for the owner; ids only, no names or settings).
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(here, "migrations", "0183_extraction_config_v1_projects.sql");

/** The migration's function definitions, rewritten to temporary functions (pg_temp is searched only when qualified). */
export function reportFunctionsSql(migrationSql) {
  const begin = migrationSql.indexOf("-- report:functions-begin");
  const end = migrationSql.indexOf("-- report:functions-end");
  if (begin < 0 || end < begin) throw new Error("migration 0183 has no report:functions markers");
  return migrationSql.slice(begin, end)
    .replaceAll("--> statement-breakpoint", "")
    .replace(/\bdocslurp_extraction_config_v1/g, "pg_temp.docslurp_extraction_config_v1");
}

export const COUNTS_SQL = `
  with rows as (
    select id, pg_temp.docslurp_extraction_config_v1_flags(pipeline) as f,
           pg_temp.docslurp_extraction_config_v1(pipeline) is distinct from pipeline as changes
      from projects
     where pipeline is not null
       and not coalesce(jsonb_typeof(pipeline) = 'object' and pipeline -> 'configVersion' = '1'::jsonb, false)
  )
  select count(*)::int as projects,
         count(*) filter (where changes)::int as rewritten,
         count(*) filter (where (f ->> 'q1')::boolean)::int as q1,
         count(*) filter (where (f ->> 'q3')::boolean)::int as q3,
         count(*) filter (where (f ->> 'q11')::boolean)::int as q11,
         count(*) filter (where (f ->> 'loweredQuality')::boolean)::int as lowered_quality,
         count(*) filter (where (f ->> 'loweredVisuals')::boolean)::int as lowered_visuals,
         coalesce(array_agg(id order by id) filter (where (f ->> 'q1')::boolean), '{}') as q1_ids,
         coalesce(array_agg(id order by id) filter (where (f ->> 'q3')::boolean), '{}') as q3_ids,
         coalesce(array_agg(id order by id) filter (where (f ->> 'q11')::boolean), '{}') as q11_ids,
         coalesce(array_agg(id order by id) filter (where (f ->> 'loweredQuality')::boolean or (f ->> 'loweredVisuals')::boolean), '{}') as lowered_ids
    from rows`;

export const LEVELS_SQL = `
  select count(*)::int as levels
    from document_extraction_levels l join projects p on p.id = l.project_id
   where l.images_status = 'resumable' and l.resume_blocked is null and p.pipeline ->> 'figureResume' in ('off', 'manual')`;

export async function extractionConfigV1Report(sql, migrationSql = readFileSync(MIGRATION, "utf8")) {
  let report;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(reportFunctionsSql(migrationSql));
      const [counts] = await tx.unsafe(COUNTS_SQL);
      const [levels] = await tx.unsafe(LEVELS_SQL);
      report = { ...counts, figure_levels_to_block: levels.levels };
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
  return report;
}

class RollbackSignal extends Error {}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const args = new Set(process.argv.slice(2));
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const report = await extractionConfigV1Report(sql);
    if (!args.has("--ids")) for (const key of ["q1_ids", "q3_ids", "q11_ids", "lowered_ids"]) delete report[key];
    if (args.has("--json")) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log("Extraction config v1 migration (0183), dry run: nothing was changed.");
    console.log(`projects to migrate                 ${report.projects} (${report.rewritten} change shape)`);
    console.log(`Q1  visionFallback off + auto       ${report.q1}  -> balanced (rescue reads on; owner confirms a large count)`);
    console.log(`Q3  figureResume off/manual         ${report.q3}  -> automatic resume for new runs`);
    console.log(`Q11 figures off + chart tier        ${report.q11}  -> visuals none (their charts stop)`);
    console.log(`lowered quality (privacy)           ${report.lowered_quality}`);
    console.log(`lowered visuals (privacy)           ${report.lowered_visuals}`);
    console.log(`resumable figure levels blocked     ${report.figure_levels_to_block}`);
    if (args.has("--ids")) for (const key of ["q1_ids", "q3_ids", "q11_ids", "lowered_ids"]) console.log(`${key}: ${report[key].join(", ") || "-"}`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[extraction-config-v1-report] ${error.message}`); process.exitCode = 1; });
}
