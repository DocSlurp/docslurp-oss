import { expect, it } from "vitest";

import { createMigratedDatabase, applyRemainingMigrations } from "../test/migrated-db.js";

it("widens populated counters and preserves attribution and run rollups", async () => {
  const db = await createMigratedDatabase({ stopBefore: "usage_event_capacity" });
  try {
    await db.exec(`
      CREATE ROLE capacity_test_reader;
      GRANT SELECT ON usage_attribution, admin_stats TO capacity_test_reader;
      ALTER VIEW usage_attribution SET (security_barrier = true, security_invoker = true);
      INSERT INTO "user" (id, name, email) VALUES ('u', 'Capacity', 'capacity@example.com');
      INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ('o', 'Capacity', 'capacity', 'u');
      INSERT INTO projects (id, org_id, user_id, name)
        VALUES ('p', 'o', 'u', 'Capacity'), ('other', 'o', 'u', 'Other');
      INSERT INTO project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, pages_total, pages_processed)
        VALUES ('r', 'o', 'u', 'p', 'upload', 'completed', 'completed', '{}', 2147483647, 2147483647);
      INSERT INTO usage_events (id, user_id, org_id, provider, model, metric, amount, unit, input_tokens, output_tokens, cost_cents, metadata)
        VALUES ('before', 'u', 'o', 'test', 'test', 'test', 99999999.9999, 'token', 2147483647, 3, 0.000000000003,
          '{"projectIds":["p","other"]}');
      INSERT INTO extracts (id, org_id, project_id, user_id, storage_prefix, retention_hours, expires_at, pages)
        VALUES ('e', 'o', 'p', 'u', 'extracts/o/e', 48, now() + interval '1 day', 2147483647);
      INSERT INTO graph_jobs (id, org_id, project_id, user_id, mode, config, config_hash, model, input_tokens)
        VALUES ('g', 'o', 'p', 'u', 'full', '{}', 'config', 'test', 2147483647);
    `);
    const attribution = () => db.query(`SELECT project_id, org_id, stamped_org_id,
      amount::text, input_tokens::text, output_tokens::text, cost_cents::text
      FROM usage_attribution WHERE id = 'before' ORDER BY project_id`);
    const view = () => db.query(`SELECT oid::text, pg_get_viewdef(oid) AS definition, relacl::text, reloptions
      FROM pg_class WHERE oid = 'usage_attribution'::regclass`);
    const originalAttribution = (await attribution()).rows;
    const originalView = (await view()).rows;
    expect(originalAttribution).toHaveLength(2);

    await applyRemainingMigrations(db, "usage_event_capacity");

    expect((await attribution()).rows).toEqual(originalAttribution);
    expect((await view()).rows).toEqual(originalView);
    expect((await db.query(`SELECT has_table_privilege('capacity_test_reader', 'admin_stats', 'SELECT') AS readable`)).rows)
      .toEqual([{ readable: true }]);
    await db.exec(`
      UPDATE project_runs SET pages_total = pages_total + 1, pages_processed = pages_processed + 1,
        total_documents = 2147483648, processed_documents = 2147483648, spend_unchecked_pages = 2147483648 WHERE id = 'r';
      REFRESH MATERIALIZED VIEW admin_stats;
      UPDATE extracts SET pages = pages + 1 WHERE id = 'e';
      UPDATE graph_jobs SET input_tokens = input_tokens + 1, output_tokens = 2147483648,
        cost_cents = cost_cents + 0.000000000003 WHERE id = 'g';
      INSERT INTO usage_events (id, user_id, org_id, project_id, provider, model, metric, amount, unit, input_tokens, output_tokens)
        VALUES ('after', 'u', 'o', 'p', 'test', 'test', 'test', 2147483648.000000000001, 'token', 2147483648, 9007199254740993);
    `);
    expect((await db.query(`SELECT pages_total::text AS pages, pg_typeof(pages_total)::text AS type FROM admin_stats`)).rows)
      .toEqual([{ pages: "2147483648", type: "bigint" }]);
    expect((await db.query(`SELECT completed_run_pages_processed::text AS pages FROM project_corpus_stats WHERE project_id = 'p'`)).rows)
      .toEqual([{ pages: "2147483648" }]);
    expect((await db.query(`SELECT input_tokens::text AS input, output_tokens::text AS output, cost_cents::text AS cost FROM graph_jobs WHERE id = 'g'`)).rows)
      .toEqual([{ input: "2147483648", output: "2147483648", cost: "0.000000000003" }]);
    expect((await db.query(`SELECT pages::text AS pages FROM extracts WHERE id = 'e'`)).rows)
      .toEqual([{ pages: "2147483648" }]);
    await expect(db.exec(`UPDATE usage_events SET amount = 'Infinity' WHERE id = 'after'`))
      .rejects.toThrow(/usage_events_amount_finite_range/);
    expect((await db.query(`SELECT trim_scale(amount)::text AS amount, trim_scale(input_tokens)::text AS input,
      trim_scale(output_tokens)::text AS output FROM usage_attribution WHERE id = 'after'`)).rows)
      .toEqual([{ amount: "2147483648.000000000001", input: "2147483648", output: "9007199254740993" }]);
  } finally {
    await db.close();
  }
}, 120_000);
