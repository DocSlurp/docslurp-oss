import { dailyStorageCredits, daysInUtcMonth } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Figure storage billing against a migrated database: the measured bytes of stored figure files (the asset ledger's
 * document_extraction_levels.asset_bytes) join the daily storage meter under the same liveness rules as source bytes,
 * per organization, once per day, through the existing cost event and credit debit.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let overview: typeof import("../services/billing/overview.js");
let meter: typeof import("../services/billing/storage-meter.js");

const MB = 1024 * 1024;
const GB = 1024 * MB;

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('ua', 'A', 'a@example.test'), ('ub', 'B', 'b@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('oa', 'A', 'fig-a', 'ua'), ('ob', 'B', 'fig-b', 'ub')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('oa', 'ua', 'owner'), ('ob', 'ub', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('pa', 'oa', 'ua', 'A'), ('pb', 'ob', 'ub', 'B')`;
  await sql`insert into extracts (id, org_id, project_id, user_id, storage_prefix, retention_hours, paid_retention, expires_at)
    values (${"ext_" + "f".repeat(32)}, 'oa', 'pa', 'ua', ${`extracts/oa/ext_${"f".repeat(32)}`}, 48, false, now() + interval '1 day')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values ('ra', 'oa', 'ua', 'pa', 'bulk-upload', 'completed', 'completed', '{}'),
           ('rb', 'ob', 'ub', 'pb', 'bulk-upload', 'completed', 'completed', '{}')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, extract_id)
    values ('rx', 'oa', 'ua', 'pa', 'bulk-upload', 'completed', 'completed', '{}', ${"ext_" + "f".repeat(32)})`;
  overview = await import("../services/billing/overview.js");
  meter = await import("../services/billing/storage-meter.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  process.env.DOCSLURP_BILL_STORAGE = "true";
  await sql`delete from usage_events`;
  await sql`delete from storage_meter_days`;
  await sql`delete from document_extraction_levels`;
  await sql`delete from documents`;
  await sql`update organizations set credit_balance_cents = 1000000`;
});

async function doc(id: string, opts: { org?: "oa" | "ob"; run?: string; status?: string; superseded?: boolean; archived?: boolean; purged?: boolean } = {}) {
  const org = opts.org ?? "oa";
  const project = org === "oa" ? "pa" : "pb";
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, file_size, page_count,
      superseded_at, archived_at, purged_at)
    values (${id}, ${org}, ${org === "oa" ? "ua" : "ub"}, ${project}, ${opts.run ?? (org === "oa" ? "ra" : "rb")}, 'Doc.pdf', 'application/pdf',
      ${`k/${id}.pdf`}, ${opts.status ?? "completed"}, ${MB}, 2,
      ${opts.superseded ? sql`now()` : null}, ${opts.archived ? sql`now()` : null}, ${opts.purged ? sql`now()` : null})`;
}

async function figures(documentId: string, bytes: number, org: "oa" | "ob" = "oa") {
  await sql`insert into document_extraction_levels (document_id, org_id, project_id, images_status, asset_bytes)
    values (${documentId}, ${org}, ${org === "oa" ? "pa" : "pb"}, 'complete', ${bytes})`;
}

describe("figure bytes in getOrgStorage", () => {
  it("raises objectBytes by exactly the stored figure bytes, and nothing else", async () => {
    await doc("d1");
    const before = await overview.getOrgStorage("oa", sql as never);
    expect(before.measuredArtifactBytes).toBe(0);
    await figures("d1", 7 * MB + 123);
    const after = await overview.getOrgStorage("oa", sql as never);
    expect(after.measuredArtifactBytes).toBe(7 * MB + 123);
    expect(after.objectBytes - before.objectBytes).toBe(7 * MB + 123);
    // The estimate (pages, index bytes) and the source bytes are unchanged: figures were never in the estimate.
    expect(after).toMatchObject({ sourceBytes: before.sourceBytes, pages: before.pages, indexBytes: before.indexBytes });
  });

  it("adds nothing for superseded, purged, failed or extract documents; counts archived versions until purge", async () => {
    await doc("live");
    await doc("superseded", { superseded: true });
    await doc("archived", { superseded: true, archived: true });
    await doc("purged", { superseded: true, archived: true, purged: true });
    await doc("failed", { status: "failed" });
    await doc("extract", { run: "rx" });
    for (const [id, bytes] of [["live", 1], ["superseded", 10], ["archived", 100], ["purged", 1000], ["failed", 10_000], ["extract", 100_000]] as const) {
      await figures(id, bytes);
    }
    expect((await overview.getOrgStorage("oa", sql as never, { excludeExtracts: true })).measuredArtifactBytes).toBe(101);
    // The billing page (no exclusion) shows the extract's figures, as it shows its source bytes.
    expect((await overview.getOrgStorage("oa", sql as never)).measuredArtifactBytes).toBe(100_101);
  });

  it("figures withheld for PII are stored but never billed (Low 9)", async () => {
    await doc("d1");
    await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, images_status, asset_bytes, assets_total, assets_extracted)
      values ('d1', 'oa', 'pa', 'ra', 'complete', 3000, 2, 2)`;
    const row = (id: string, n: number, bytes: number) => sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number,
        kind, fate, status, format, source, bytes, sha256, width, height, link_path, file_of, storage_key, storage_state)
      values ('d1', 'oa', 'pa', 'ra', ${id}, ${n}, 'picture', 'block', 'extracted', 'webp', 'render', ${bytes}, ${"a".repeat(64)}, 10, 10,
        ${`images/page-000${n}/image-001.webp`}, ${id}, ${`ua/ra/doppler/d1/images/page-000${n}/image-001.webp`}, 'stored')`;
    await row("p1.1", 1, 1000);
    await row("p2.1", 2, 2000);
    expect((await overview.getOrgStorage("oa", sql as never)).measuredArtifactBytes).toBe(3000);
    await sql`update documents set metadata = ${sql.json({ pii: { scope: "pages", pages: [2], withheldArtifactUris: ["s3://bucket/ua/ra/doppler/d1/images/page-0002/image-001.webp"] } })} where id = 'd1'`;
    expect((await overview.getOrgStorage("oa", sql as never)).measuredArtifactBytes).toBe(1000);
    await sql`delete from document_assets`;
  });

  it("R3-M1: withheld figures are subtracted in linear time (5,000 withheld figures under a bound)", async () => {
    await doc("big");
    const n = 5000;
    await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, images_status, asset_bytes, assets_total, assets_extracted)
      values ('big', 'oa', 'pa', 'ra', 'complete', ${n * 100 + 1000}, ${n + 1}, ${n + 1})`;
    await sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, format, source, bytes, sha256,
        width, height, link_path, file_of, storage_key, storage_state)
      select 'big', 'oa', 'pa', 'ra', 'p' || g || '.1', g, 'picture', 'block', 'extracted', 'webp', 'render', 100, ${"a".repeat(64)}, 10, 10,
        'images/page-' || lpad(g::text, 4, '0') || '/image-001.webp', 'p' || g || '.1',
        'ua/ra/doppler/big/images/page-' || lpad(g::text, 4, '0') || '/image-001.webp', 'stored'
      from generate_series(1, ${n + 1}) g`;
    // Every figure but the last is on the withheld list (as main's PII stage writes it under redact_artifacts).
    await sql`update documents set metadata = jsonb_build_object('pii', jsonb_build_object('redacted', true, 'withheldArtifactUris',
        (select jsonb_agg('s3://bucket/ua/ra/doppler/big/images/page-' || lpad(g::text, 4, '0') || '/image-001.webp') from generate_series(1, ${n}) g)))
      where id = 'big'`;
    const started = Date.now();
    const storage = await overview.getOrgStorage("oa", sql as never);
    const elapsed = Date.now() - started;
    console.log(`[test] withheld subtraction over ${n} figures: ${elapsed} ms`);
    // Billed: the level's bytes less the n withheld figures.
    expect(storage.measuredArtifactBytes).toBe(1000);
    // The old per-row scan of the list took ~33 s for 4,000 figures on PGlite; with the key index, ~0.1 s for 5,000.
    expect(elapsed).toBeLessThan(5000);
    await sql`delete from document_assets`;
  }, 120_000);

  it("R3-L1: an extract document's withheld figures are never subtracted when its figures are not counted (excludeExtracts)", async () => {
    await doc("live");
    await doc("extract", { run: "rx" });
    await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, images_status, asset_bytes, assets_total, assets_extracted)
      values ('live', 'oa', 'pa', 'ra', 'complete', 1000, 1, 1), ('extract', 'oa', 'pa', 'rx', 'complete', 500, 1, 1)`;
    await sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, format, source, bytes, sha256,
        width, height, link_path, file_of, storage_key, storage_state)
      values ('extract', 'oa', 'pa', 'rx', 'p1.1', 1, 'picture', 'block', 'extracted', 'webp', 'render', 500, ${"a".repeat(64)}, 10, 10,
        'images/page-0001/image-001.webp', 'p1.1', 'ua/rx/doppler/extract/images/page-0001/image-001.webp', 'stored')`;
    await sql`update documents set metadata = ${sql.json({ pii: { redacted: true, withheldArtifactUris: ["s3://bucket/ua/rx/doppler/extract/images/page-0001/image-001.webp"] } })} where id = 'extract'`;
    // The meter (extracts excluded) bills the live document's 1000 bytes in full: nothing of the extract is subtracted.
    expect((await overview.getOrgStorage("oa", sql as never, { excludeExtracts: true })).measuredArtifactBytes).toBe(1000);
    // The billing page counts the extract's figures and subtracts its withheld ones.
    expect((await overview.getOrgStorage("oa", sql as never)).measuredArtifactBytes).toBe(1000);
    await sql`delete from document_assets`;
  });

  it("never counts another organization's figures", async () => {
    await doc("a1");
    await doc("b1", { org: "ob" });
    await figures("a1", 5);
    await figures("b1", 50 * MB, "ob");
    expect((await overview.getOrgStorage("oa", sql as never)).measuredArtifactBytes).toBe(5);
    expect((await overview.getOrgStorage("ob", sql as never)).measuredArtifactBytes).toBe(50 * MB);
    expect((await overview.getOrgStorage("nobody", sql as never)).measuredArtifactBytes).toBe(0);
  });

  it("refuses a ledger level row that names another organization's document", async () => {
    await doc("b2", { org: "ob" });
    await expect(sql`insert into document_extraction_levels (document_id, org_id, project_id, asset_bytes) values ('b2', 'oa', 'pa', 99)`)
      .rejects.toMatchObject({ code: "23503" });
    expect((await overview.getOrgStorage("oa", sql as never)).measuredArtifactBytes).toBe(0);
  });
});

describe("the daily storage meter charges figure bytes", () => {
  it("charges once per day for objects including figures, records measuredArtifactBytes and leaves compute untouched", async () => {
    await doc("m1");
    await figures("m1", 3 * GB);
    // A compute charge already on the books for this org.
    await sql`insert into usage_events (id, user_id, provider, model, metric, amount, unit, cost_cents, input_tokens, output_tokens, metadata, org_id)
      values ('compute-1', 'ua', 'docslurp', 'pipeline', 'pages', 10, 'pages', 4.5, 0, 0, '{}'::jsonb, 'oa')`;
    const storage = await overview.getOrgStorage("oa", sql as never, { excludeExtracts: true });
    const now = new Date("2026-11-12T03:00:00Z");
    const day = meter.utcDay(now);
    const expected = dailyStorageCredits(storage.objectBytes + storage.indexBytes, daysInUtcMonth(day));
    expect(expected).toBeGreaterThan(dailyStorageCredits(storage.objectBytes - 3 * GB + storage.indexBytes, daysInUtcMonth(day)));

    const [{ balance: start }] = await sql<{ balance: number }[]>`select credit_balance_cents::float8 as balance from organizations where id = 'oa'`;
    await meter.runStorageMeter({ now });
    await meter.runStorageMeter({ now });

    const days = await sql<{ measured: number; object_bytes: number }[]>`
      select measured_artifact_bytes::float8 as measured, object_bytes::float8 as object_bytes from storage_meter_days where org_id = 'oa'`;
    expect(days).toEqual([{ measured: 3 * GB, object_bytes: storage.objectBytes }]);
    const events = await sql<{ id: string; cost: number; metadata: Record<string, unknown> }[]>`
      select id, cost_cents::float8 as cost, metadata from usage_events where org_id = 'oa' and id like 'storage:%'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.cost).toBeCloseTo(expected, 9);
    expect(events[0]!.metadata).toMatchObject({ measuredArtifactBytes: 3 * GB, estimate: true });
    const [{ balance: end }] = await sql<{ balance: number }[]>`select credit_balance_cents::float8 as balance from organizations where id = 'oa'`;
    expect(start - end).toBeCloseTo(expected, 9);
    // The compute charge is unchanged, and no other event was written.
    const others = await sql<{ id: string; cost: number }[]>`select id, cost_cents::float8 as cost from usage_events where id not like 'storage:%'`;
    expect(others).toEqual([{ id: "compute-1", cost: 4.5 }]);
    // Org B had nothing stored, so it was not metered, and org A's figures never reached it.
    expect((await sql`select 1 from storage_meter_days where org_id = 'ob'`).length).toBe(0);
  });
});
