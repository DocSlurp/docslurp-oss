import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  mapLegacyExtractionSettings,
  migrateProjectPipelineToConfigV1,
  parseStoredPipelineFeatures,
  projectFigureResumeMode,
  projectFiguresOff,
  QUALITY_LEVEL_RANK,
  qualityLevelFromLegacy,
  VISUALS_LEVEL_RANK,
  visualsLevelFromLegacy,
  type VisualsLevel,
} from "@docslurp/shared";
import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";
// @ts-expect-error plain .mjs script without types
import { COUNTS_SQL, LEVELS_SQL, reportFunctionsSql, UNSUPPORTED_SQL } from "../../db/extraction-config-v1-report.mjs";
import { readFileSync } from "node:fs";

/**
 * Migration 0183 (extraction config v1, release R1): stored project pipelines move to `quality`/`visuals` with
 * `configVersion: 1`. The SQL functions and the TypeScript twin (`migrateProjectPipelineToConfigV1`) must agree on every
 * fixture; the migrated rows must read back (release R0's stored reads) without raising quality or visuals beyond Q1;
 * resumable figure levels of `figureResume: off`/`manual` projects are blocked; a second run changes nothing.
 */
const MIGRATION = "extraction_config_v1_projects";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
let dryRun: Record<string, unknown>;
let pipelinesBeforeDryRun: unknown[];

const FIXTURES: Record<string, unknown> = {
  empty: {},
  fast: { quality: "fast" },
  auto: { quality: "auto" },
  good: { quality: "good" },
  autoFallbackOff: { quality: "auto", visionFallback: false },
  noQualityFallbackOff: { visionFallback: false },
  fastFallbackOff: { quality: "fast", visionFallback: false },
  goodFallbackOff: { quality: "good", visionFallback: false },
  nullQuality: { quality: null, visionFallback: false },
  playbookFast: { parserPlaybook: "fast" },
  playbookReview: { parserPlaybook: "review-grade" },
  playbookWithQuality: { parserPlaybook: "fast", quality: "good" },
  forceAll: { vision: { profile: "good-fast-hosted", forceAllPages: true } },
  forceAllFalse: { quality: "fast", vision: { profile: "good-fast-hosted", forceAllPages: false } },
  figuresOff: { figures: false },
  figuresOffFree: { figures: false, chartExport: { tier: "free", formats: ["description"], diagrams: false } },
  figuresOffModels: { figures: false, chartExport: { tier: "models" } },
  tierOff: { chartExport: { tier: "off", formats: ["description", "csv"], diagrams: true } },
  tierFree: { chartExport: { tier: "free" } },
  tierModels: { chartExport: { tier: "models", formats: ["mermaid"] } },
  enabledLegacy: { chartExport: { enabled: true, generatorModel: "llm://openrouter/example/model" } },
  enabledWithTier: { chartExport: { enabled: true, tier: "free" } },
  disabledLegacy: { chartExport: { enabled: false } },
  goodPrivacy: { quality: "good", privacyMode: "local-only", embed: false, indexVectors: false },
  goodPrivacyLocal: { quality: "good", privacyMode: "strict-privacy", vision: { profile: "good-fast-local" }, embed: false, indexVectors: false },
  goodPrivacyPrivateTarget: { quality: "good", privacyMode: "local-only", vision: { target: "private" }, embed: false, indexVectors: false },
  modelsPrivacy: { chartExport: { tier: "models" }, privacyMode: "local-only", embed: false, indexVectors: false },
  resumeOff: { figureResume: "off" },
  resumeManual: { figureResume: "manual", quality: "good" },
  resumeAuto: { figureResume: "auto" },
  alreadyNew: { quality: "smart", visuals: "charts", configVersion: 1 },
  mixedNewQuality: { quality: "balanced", visionFallback: false },
  keepsOtherKeys: { quality: "auto", summarize: true, piiPolicy: { enabled: true, action: "flag_for_review", patterns: ["ssn"] }, ladder: { maxRung: 2 } },
  scalar: "x",
  figuresOffString: { figures: "off", chartExport: { tier: "free" } },
  figuresOffObject: { figures: { enabled: false } },
  numericQuality: { quality: 5, visionFallback: false },
  unknownQuality: { quality: "medium", visionFallback: false },
  versionTwo: { quality: "fast", configVersion: 2 },
  versionString: { quality: "good", configVersion: "1" },
  chartExportNull: { chartExport: null, quality: "good" },
  chartExportArray: { chartExport: ["x"], figures: false },
  tierNull: { chartExport: { tier: null } },
  hostedTargetLocalProfile: { quality: "good", privacyMode: "local-only", vision: { profile: "good-fast-local", target: "hosted" }, embed: false, indexVectors: false },
  goodStandard: { quality: "good", privacyMode: "standard" },
};

async function sqlJson<T>(query: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(query, params);
  return rows[0]!.value;
}

beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: MIGRATION });
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'U', 'u1@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'O', 'o1-slug', 'u1');
  `);
  for (const [id, pipeline] of Object.entries(FIXTURES)) {
    await db.query(`insert into projects(id, org_id, user_id, name, pipeline) values ($1, 'o1', 'u1', $1, $2::jsonb)`, [id, JSON.stringify(pipeline)]);
  }
  for (const [document, project, status] of [["d-off", "resumeOff", "resumable"], ["d-manual", "resumeManual", "resumable"], ["d-auto", "resumeAuto", "resumable"], ["d-off-complete", "resumeOff", "complete"]] as const) {
    await db.query(`insert into documents(id, org_id, user_id, project_id, filename, mime_type, source_key, status, page_count) values ($1, 'o1', 'u1', $2, 'a.pdf', 'application/pdf', $3, 'completed', 2)`, [document, project, `u1/raw/${document}.pdf`]);
    await db.query(`insert into document_extraction_levels(document_id, org_id, project_id, images_status, assets_resumable, assets_not_extracted, assets_total) values ($1, 'o1', $2, $3, $4, $4, $4)`, [document, project, status, status === "resumable" ? 1 : 0]);
  }
  // The owner's dry run (server/db/extraction-config-v1-report.mjs) before the migration: its counts, then a rollback.
  pipelinesBeforeDryRun = (await db.query(`select id, pipeline from projects order by id`)).rows;
  await db.exec("begin");
  await db.exec(reportFunctionsSql(readFileSync(new URL("../../db/migrations/0183_extraction_config_v1_projects.sql", import.meta.url), "utf8")));
  dryRun = { ...(await db.query<Record<string, unknown>>(COUNTS_SQL)).rows[0], ...(await db.query<Record<string, unknown>>(LEVELS_SQL)).rows[0], ...(await db.query<Record<string, unknown>>(UNSUPPORTED_SQL)).rows[0] };
  await db.exec("rollback");
  expect((await db.query(`select id, pipeline from projects order by id`)).rows).toEqual(pipelinesBeforeDryRun);
  await applyRemainingMigrations(db, MIGRATION);
}, 300_000);

afterAll(async () => { await db?.close(); });

describe("migration 0183 extraction config v1", () => {
  it("the SQL functions agree with the TypeScript twin on every fixture (pipeline and flags)", async () => {
    for (const [id, pipeline] of Object.entries(FIXTURES)) {
      const ts = migrateProjectPipelineToConfigV1(pipeline);
      expect(await sqlJson(`select docslurp_extraction_config_v1($1::jsonb) as value`, [JSON.stringify(pipeline)]), id).toEqual(ts.pipeline);
      expect(await sqlJson(`select docslurp_extraction_config_v1_flags($1::jsonb) as value`, [JSON.stringify(pipeline)]), id).toEqual(ts.flags);
    }
  });

  it("rewrites every stored row to the twin's output, and leaves rows already in the new shape alone", async () => {
    const { rows } = await db.query<{ id: string; pipeline: unknown }>(`select id, pipeline from projects`);
    for (const row of rows) {
      const before = FIXTURES[row.id];
      const unchanged = ["alreadyNew", "versionTwo", "versionString"].includes(row.id);
      expect(row.pipeline, row.id).toEqual(unchanged ? before : migrateProjectPipelineToConfigV1(before).pipeline);
    }
  });

  it("flags Q1, Q3, Q11 and the refused combinations", () => {
    const flagged = (key: keyof ReturnType<typeof migrateProjectPipelineToConfigV1>["flags"]) =>
      Object.entries(FIXTURES).filter(([, pipeline]) => migrateProjectPipelineToConfigV1(pipeline).flags[key]).map(([id]) => id).sort();
    expect(flagged("q1")).toEqual(["autoFallbackOff", "mixedNewQuality", "noQualityFallbackOff", "nullQuality", "numericQuality", "unknownQuality"]);
    expect(flagged("q3")).toEqual(["resumeManual", "resumeOff"]);
    expect(flagged("q11")).toEqual(["figuresOffFree", "figuresOffModels", "figuresOffString"]);
    expect(flagged("loweredQuality")).toEqual(["goodPrivacy", "hostedTargetLocalProfile"]);
    expect(flagged("unsupportedVersion")).toEqual(["versionString", "versionTwo"]);
    expect(flagged("loweredVisuals")).toEqual(["modelsPrivacy"]);
  });

  it("never raises effective quality or visuals except Q1, as release R0 reads the migrated rows back", () => {
    const visualsRank = (level: VisualsLevel | null) => (level === null ? null : VISUALS_LEVEL_RANK[level]);
    for (const [id, pipeline] of Object.entries(FIXTURES)) {
      if (["scalar", "alreadyNew", "versionTwo", "versionString"].includes(id)) continue;
      const before = parseStoredPipelineFeatures(pipeline, id);
      const migrated = migrateProjectPipelineToConfigV1(pipeline);
      const after = parseStoredPipelineFeatures(migrated.pipeline, id);
      // Quality never goes up a rung.
      expect(QUALITY_LEVEL_RANK[qualityLevelFromLegacy(after.quality)], id).toBeLessThanOrEqual(QUALITY_LEVEL_RANK[qualityLevelFromLegacy(before.quality)]);
      // visionFallback (rescue reads, page rasters, estimates) turns on only for Q1, at any quality.
      if (before.visionFallback === false && after.visionFallback !== false) expect(migrated.flags.q1, id).toBe(true);
      // Every figures-off shape stays off for the figure readers (resume, runner, sweeps).
      if (projectFiguresOff(pipeline)) expect(projectFiguresOff(migrated.pipeline), id).toBe(true);
      // Figure resume never opens up: an opted-out project is counted (Q3) and its partial levels blocked.
      if (projectFigureResumeMode(pipeline) !== "auto" && projectFigureResumeMode(migrated.pipeline) === "auto") expect(migrated.flags.q3, id).toBe(true);
      // Visuals: unset stays unset; a set rung never goes up.
      const beforeVisuals = visualsLevelFromLegacy({ figures: before.figures, tier: before.chartExport?.tier }, { explicitFreeAllowed: true });
      const afterVisuals = visualsLevelFromLegacy({ figures: after.figures, tier: after.chartExport?.tier }, { explicitFreeAllowed: true });
      // Unset stays unset (the origin default), or lowers to none for a figures-off shape the stored read let through.
      if (beforeVisuals === null) expect([null, "none"], id).toContain(afterVisuals);
      else expect(visualsRank(afterVisuals) ?? -1, id).toBeLessThanOrEqual(visualsRank(beforeVisuals)!);
      // Figures never turn on.
      if (before.figures === false) expect(after.figures, id).toBe(false);
      // The mapping table itself agrees with the stored read.
      expect(qualityLevelFromLegacy(after.quality), id).toBe(mapLegacyExtractionSettings(pipeline, { explicitFreeAllowed: true }).quality);
    }
  });

  it("the dry-run report counts what the migration then changes, without changing anything", () => {
    expect(dryRun).toMatchObject({
      projects: Object.keys(FIXTURES).length - 3, // alreadyNew and the two versioned rows are skipped
      unsupported_version_left: 2, q1: 6, q3: 2, q11: 3, lowered_quality: 2, lowered_visuals: 1, levels: 2,
      q1_ids: ["autoFallbackOff", "mixedNewQuality", "noQualityFallbackOff", "nullQuality", "numericQuality", "unknownQuality"],
      q11_ids: ["figuresOffFree", "figuresOffModels", "figuresOffString"],
    });
  });

  it("keeps chart formats and diagrams and every unrelated key", async () => {
    expect(await sqlJson(`select pipeline as value from projects where id = 'tierOff'`)).toEqual({ chartExport: { formats: ["description", "csv"], diagrams: true }, quality: "balanced", visuals: "figures", configVersion: 1 });
    expect(await sqlJson(`select pipeline as value from projects where id = 'keepsOtherKeys'`)).toEqual({ ...(FIXTURES.keepsOtherKeys as object), quality: "balanced", configVersion: 1 });
  });

  it("blocks resumable figure levels of projects that turned resume off or manual, and nothing else", async () => {
    const { rows } = await db.query<{ document_id: string; resume_blocked: string | null }>(`select document_id, resume_blocked from document_extraction_levels order by document_id`);
    expect(Object.fromEntries(rows.map((row) => [row.document_id, row.resume_blocked]))).toEqual({
      "d-auto": null, "d-manual": "resume-off", "d-off": "resume-off", "d-off-complete": null,
    });
  });

  it("is idempotent: a second application changes nothing", async () => {
    const before = await db.query(`select id, pipeline from projects order by id`);
    await db.exec(`update projects set pipeline = docslurp_extraction_config_v1(pipeline) where not docslurp_extraction_config_v1_versioned(pipeline)`);
    const after = await db.query(`select id, pipeline from projects order by id`);
    expect(after.rows).toEqual(before.rows);
  });
});

describe("migration 0183 pauses on a large Q1 count", () => {
  it("refuses to rewrite when more projects than the confirmed limit would gain rescue reads, and runs once confirmed", async () => {
    const gate = await createMigratedDatabase({ stopBefore: MIGRATION });
    try {
      await gate.exec(`
        insert into "user"(id, name, email) values ('u1', 'U', 'u1@example.com');
        insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'O', 'o1-slug', 'u1');
        insert into projects(id, org_id, user_id, name, pipeline) values
          ('a', 'o1', 'u1', 'a', '{"quality": "auto", "visionFallback": false}'), ('b', 'o1', 'u1', 'b', '{"visionFallback": false}');
        select set_config('docslurp.extraction_config_v1_max_q1', '1', false);
      `);
      await expect(applyRemainingMigrations(gate, MIGRATION)).rejects.toThrow(/2 projects would move .* above the confirmed limit 1/);
      expect((await gate.query<{ pipeline: unknown }>(`select pipeline from projects where id = 'a'`)).rows[0]!.pipeline).toEqual({ quality: "auto", visionFallback: false });
      await gate.exec(`select set_config('docslurp.extraction_config_v1_max_q1', '2', false)`);
      await applyRemainingMigrations(gate, MIGRATION);
      expect((await gate.query<{ pipeline: unknown }>(`select pipeline from projects where id = 'a'`)).rows[0]!.pipeline).toEqual({ quality: "balanced", configVersion: 1 });
    } finally {
      await gate.close();
    }
  }, 300_000);
});
