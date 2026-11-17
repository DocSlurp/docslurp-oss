import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BILLABLE_UNIT_METRICS, unitChargeMetadata } from "@docslurp/shared";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Billing forecast page counts (orgUnitUsage) against a migrated Postgres: each charged page counts once per run, in
 * its final class (Text, Scan, Vision), while credits stay the exact sum of the charges. Charges are written as the
 * worker writes them, so the page-read settle trigger (migration 0185) turns an OCR-then-vision page into an upgrade.
 * Credit amounts below are arbitrary test numbers, not prices.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql;
let attribution: typeof import("../services/usage-attribution.js");

const ORG_A = "org-a";
const ORG_B = "org-b";
const RUN_A1 = "run-a1";
const RUN_A2 = "run-a2";
const RUN_B = "run-b";
const DOC = "doc-1";
const SCAN = 2;
const VISION = 7;
const TEXT = 1;
const orgOf: Record<string, string> = { [RUN_A1]: ORG_A, [RUN_A2]: ORG_A, [RUN_B]: ORG_B };
const projectOf = (orgId: string) => `p-${orgId}`;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.test')`;
  attribution = await import("../services/usage-attribution.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from usage_events`;
  await sql`delete from project_runs`;
  await sql`delete from projects`;
  await sql`delete from organizations`;
  for (const orgId of [ORG_A, ORG_B]) {
    await sql`insert into organizations(id, name, slug, created_by_user_id) values (${orgId}, ${orgId}, ${orgId}, 'u1')`;
    await sql`insert into projects(id, org_id, user_id, name) values (${projectOf(orgId)}, ${orgId}, 'u1', 'P')`;
  }
  for (const [runId, orgId] of Object.entries(orgOf)) {
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage)
      values (${runId}, ${orgId}, 'u1', ${projectOf(orgId)}, 'bulk-upload', 'running', 'extract')`;
  }
});

/** One page charge, inserted the way the worker persists it (one statement per row, so the settle trigger runs). */
async function charge(runId: string, id: string, metric: string, costCents: number, metadata: Record<string, unknown>, amount = 1) {
  const orgId = orgOf[runId]!;
  await sql`
    insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata, org_id, project_id)
    values (${id}, 'u1', ${runId}, 'docslurp', 'price-card', ${metric}, ${amount}, 'page', ${costCents},
      ${JSON.stringify(unitChargeMetadata({ projectId: projectOf(orgId), ...metadata }))}::text::jsonb, ${orgId}, ${projectOf(orgId)})
  `;
}

const scan = (runId: string, page: number) =>
  charge(runId, `ocr:${runId}:${DOC}:${page}`, BILLABLE_UNIT_METRICS.ocrPage, SCAN, { documentId: DOC, pageNumber: page });
const vision = (runId: string, page: number, unit = 1, extra: Record<string, unknown> = {}) =>
  charge(runId, unit === 1 ? `rich:${runId}:${DOC}:${page}` : `rich:${runId}:${DOC}:${page}:unit:${unit}`,
    BILLABLE_UNIT_METRICS.richPage, VISION, { documentId: DOC, pageNumber: page, ...(unit > 1 ? { unit } : {}), ...extra });
const text = (runId: string, page: number) =>
  charge(runId, `${runId}:${DOC}:${page}`, BILLABLE_UNIT_METRICS.fastPage, TEXT, { documentId: DOC, page, materialized: true, pageRules: 2 });

const usageOf = (orgId: string) => attribution.orgUnitUsage(orgId, null, sql as never);

describe("org page counts by final class", () => {
  it("counts a page OCR-read and then vision-read once, as Vision, and its credits match the charges", async () => {
    await scan(RUN_A1, 1);
    await vision(RUN_A1, 1);
    const [upgrade] = await sql<{ cost_cents: number; metadata: Record<string, unknown> }[]>`
      select cost_cents::double precision as cost_cents, metadata from usage_events where id = ${`rich:${RUN_A1}:${DOC}:1`}`;
    expect(upgrade?.metadata).toMatchObject({ upgradeOf: `ocr:${RUN_A1}:${DOC}:1`, upgradeFrom: "ocr" });
    expect(Number(upgrade?.cost_cents)).toBe(VISION - SCAN);

    const usage = await usageOf(ORG_A);
    expect(usage).toMatchObject({ fastPages: 0, ocrPages: 0, richPages: 1 });
    // The page paid Vision once in all: Scan plus the upgrade difference.
    expect(usage.ingestCredits).toBe(VISION);
    expect(usage.richPages * VISION).toBe(usage.ingestCredits);
  });

  it("leaves Scan-only and Vision-only pages unchanged and counts a multi-unit Vision page once", async () => {
    await scan(RUN_A1, 1);
    await vision(RUN_A1, 2);
    for (const unit of [1, 2, 3]) await vision(RUN_A1, 3, unit);
    await text(RUN_A1, 4);

    const usage = await usageOf(ORG_A);
    expect(usage).toMatchObject({ fastPages: 1, ocrPages: 1, richPages: 2 });
    expect(usage.ingestCredits).toBe(TEXT + SCAN + VISION + 3 * VISION);
  });

  it("counts a page read by vision first and then OCR once, as Vision (the OCR charge is never written)", async () => {
    await vision(RUN_A1, 1);
    await scan(RUN_A1, 1);
    const [ocrRows] = await sql<{ n: number }[]>`select count(*)::int as n from usage_events where id = ${`ocr:${RUN_A1}:${DOC}:1`}`;
    expect(ocrRows?.n).toBe(0);
    const usage = await usageOf(ORG_A);
    expect(usage).toMatchObject({ fastPages: 0, ocrPages: 0, richPages: 1 });
    expect(usage.ingestCredits).toBe(VISION);
  });

  it("counts a page another run of the org upgraded from Scan once, as Vision", async () => {
    await scan(RUN_A1, 6);
    await charge(RUN_A2, `rich-upgrade:${DOC}:6`, BILLABLE_UNIT_METRICS.richPage, VISION - SCAN, {
      documentId: DOC, pageNumber: 6, readBy: "model-read", upgradeOf: `ocr:${RUN_A1}:${DOC}:6`, upgradeFrom: "ocr", decidedBy: RUN_A1,
    });
    const usage = await usageOf(ORG_A);
    expect(usage).toMatchObject({ fastPages: 0, ocrPages: 0, richPages: 1 });
    expect(usage.ingestCredits).toBe(VISION);
  });

  it("counts a page another run of the org upgraded from Text once, as Vision", async () => {
    await text(RUN_A1, 4);
    await charge(RUN_A2, `rich-upgrade:${DOC}:4`, BILLABLE_UNIT_METRICS.richPage, VISION - TEXT, {
      documentId: DOC, pageNumber: 4, readBy: "model-read", upgradeOf: `${RUN_A1}:${DOC}:4`, upgradeFrom: "fast", decidedBy: RUN_A1,
    });
    const usage = await usageOf(ORG_A);
    expect(usage).toMatchObject({ fastPages: 0, ocrPages: 0, richPages: 1 });
    expect(usage.ingestCredits).toBe(VISION);
  });

  it("never lets another org's or another run's events change an org's counts", async () => {
    await scan(RUN_A1, 1);
    await text(RUN_A1, 4);
    const before = await usageOf(ORG_A);
    expect(before).toMatchObject({ fastPages: 1, ocrPages: 1, richPages: 0 });

    // Another org forges upgrades naming org A's charges, run and document exactly.
    await charge(RUN_B, `rich:${RUN_B}:${DOC}:1`, BILLABLE_UNIT_METRICS.richPage, VISION, {
      documentId: DOC, pageNumber: 1, upgradeOf: `ocr:${RUN_A1}:${DOC}:1`, upgradeFrom: "ocr", decidedBy: RUN_A1,
    });
    await charge(RUN_B, `rich-upgrade:${DOC}:4`, BILLABLE_UNIT_METRICS.richPage, VISION, {
      documentId: DOC, pageNumber: 4, upgradeOf: `${RUN_A1}:${DOC}:4`, upgradeFrom: "fast", decidedBy: RUN_A1,
    });
    await scan(RUN_B, 9);
    expect(await usageOf(ORG_A)).toEqual(before);
    expect(await usageOf(ORG_B)).toMatchObject({ fastPages: 0, ocrPages: 1, richPages: 2 });

    // Another run of the same org reads the same page: its own Vision charge is its own page, and an upgrade link that
    // does not name the deciding run removes nothing from run A1.
    await vision(RUN_A2, 1, 1, { upgradeOf: `ocr:${RUN_A1}:${DOC}:1`, upgradeFrom: "ocr" });
    const after = await usageOf(ORG_A);
    expect(after).toMatchObject({ fastPages: 1, ocrPages: 1, richPages: 1 });
    expect(after.ingestCredits).toBe(before.ingestCredits + VISION);
  });
});
