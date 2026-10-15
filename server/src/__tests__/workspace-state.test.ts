import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { workspaceStateQuerySchema, workspaceStateSchema } from "@docslurp/shared";
import { getWorkspaceState, mapWorkspaceState } from "../services/workspace-state.js";
import type { SqlClient } from "../db.js";

const args = { workspaceId: "state-workspace", orgId: "state-org", recentWindowHours: 24 };

describe("workspace state", () => {
  it("retains missing samples, zero throughput, and fractional cost without invented performance", () => {
    const state = mapWorkspaceState({ observed_at: "2026-10-06T12:00:00Z", source_bytes: "2500000", text_bytes: "125000", cost_cents: "0.005", total_pages: "10", indexed_pages: "3", search_samples: "1", search_p50: 0, search_p95: 0, search_max: 0 }, args);
    expect(workspaceStateSchema.parse(state)).toEqual(state);
    expect(state.pages).toMatchObject({ total: 10, indexed: 3, notIndexed: 7 });
    expect(state.storage).toMatchObject({ sourceMb: 2.5, textMb: 0.125, vectorBytes: null, artifactBytes: null });
    expect(state.searches.latencyMs).toEqual({ sampleCount: 1, p50: 0, p95: 0, max: 0 });
    expect(state.performance.pagesPerMinute).toBeNull();
    expect(state.performance.durationMs).toEqual({ sampleCount: 0, p50: null, p95: null, max: null });
    expect(state.usage.costCents).toBe(0.005);
  });

  it("bounds the query window and labels wall-time ingestion throughput", () => {
    expect(workspaceStateQuerySchema.parse({})).toEqual({ recentWindowHours: 24 });
    for (const recentWindowHours of [0, 721, 1.5, "bad"]) expect(workspaceStateQuerySchema.safeParse({ recentWindowHours }).success).toBe(false);
    const state = mapWorkspaceState({ observed_at: "2026-10-06T12:00:00Z", completed_pages: 120, run_duration_total_ms: 120_000 }, args);
    expect(state.performance).toMatchObject({ pagesPerMinute: 60, minutesPer100Pages: 100 / 60, basis: "run-wall-time-including-queue" });
    expect(state.recentWindow.from).toBe("2026-10-05T12:00:00.000Z");
  });
});

// Optional real PostgreSQL seam. Uses connection-local temporary tables only.
const integrationUrl = process.env.WORKSPACE_STATE_TEST_DATABASE_URL;
const client = integrationUrl ? postgres(integrationUrl, { max: 1 }) : null;
afterAll(async () => { await client?.end(); });

describe.skipIf(!client)("workspace state PostgreSQL aggregates", () => {
  it("deduplicates searchable pages, excludes other tenants and history, and handles bad metadata", async () => {
    await client!.begin(async (tx) => {
      await tx.unsafe(`
        create temporary table workspaces (id text, org_id text) on commit drop;
        create temporary table documents (id text, workspace_id text, run_id text, status text, page_count int, file_size bigint, metadata jsonb, superseded_at timestamptz) on commit drop;
        create temporary table workspace_corpus_stats (workspace_id text, document_count bigint, page_count bigint, source_bytes bigint, updated_at timestamptz default now()) on commit drop;
        create temporary table document_pages (id text, document_id text, run_id text, page_number int, text text) on commit drop;
        create temporary table document_chunks (document_id text, run_id text, page_number int, parent_page_id text, text text) on commit drop;
        create temporary table workspace_runs (id text, workspace_id text, org_id text, status text, pages_processed int, created_at timestamptz, updated_at timestamptz) on commit drop;
        create temporary table search_sessions (id text, result_count int, created_at timestamptz, metadata jsonb) on commit drop;
        create temporary table usage_events (id text, created_at timestamptz, run_id text, metric text, provider text, metadata jsonb, input_tokens numeric, output_tokens numeric, cost_cents numeric) on commit drop;
        insert into workspaces values ('state-workspace', 'state-org'), ('other-workspace', 'other-org');
        insert into documents (id, workspace_id, run_id, status, page_count, file_size, metadata, superseded_at) values
          ('doc', 'state-workspace', 'current-run', 'completed', 3, 2000000, '{"sourceSizeMeasured":true}', null),
          ('superseded', 'state-workspace', 'old-run', 'completed', 4, 1000000, '{"sourceSizeMeasured":true}', now()),
          ('pending', 'state-workspace', 'current-run', 'queued', 2, 0, '{}', null),
          ('unknown', 'state-workspace', 'current-run', 'queued', 0, 0, '{}', null),
          ('staged', 'state-workspace', 'current-run', 'embed', 1, 0, '{}', null),
          ('other', 'other-workspace', 'other-run', 'completed', 900, 9000000, '{}', null);
        insert into workspace_corpus_stats (workspace_id, document_count, page_count, source_bytes) values
          ('state-workspace', 1, 3, 2000000), ('other-workspace', 1, 900, 9000000);
        insert into document_pages values
          ('page1', 'doc', 'current-run', 1, 'one'),
          ('duplicate', 'doc', 'current-run', 1, 'one'),
          ('old-page', 'doc', 'old-run', 3, 'old'),
          ('superseded-page', 'superseded', 'old-run', 4, 'replaced version'),
          ('other-page', 'other', 'other-run', 1, 'other'),
          ('queued-page', 'pending', 'current-run', 1, 'not searchable yet'),
          ('empty-page', 'doc', 'current-run', 3, '   ');
        insert into document_chunks values
          ('doc', 'current-run', 1, null, 'chunk1'),
          ('doc', 'current-run', 1, null, 'chunk2'),
          ('doc', 'current-run', 2, null, 'chunk3'),
          ('doc', 'current-run', 99, null, 'invalid'),
          ('pending', 'current-run', 2, null, 'not searchable yet');
        insert into workspace_runs values
          ('current-run', 'state-workspace', 'state-org', 'completed', 3, now() - interval '1 minute', now()),
          ('old-run', 'state-workspace', 'state-org', 'completed', 3, now() - interval '3 days', now() - interval '3 days' + interval '1 minute'),
          ('other-run', 'other-workspace', 'other-org', 'completed', 900, now() - interval '1 minute', now());
        insert into search_sessions values
          ('numeric', 1, now(), '{"workspaceId":"state-workspace","durationMs":100}'),
          ('multi', 0, now(), '{"workspaceIds":["state-workspace","other-workspace"],"durationMs":300}'),
          ('bad-number', 1, now(), '{"workspaceId":"state-workspace","durationMs":"invalid"}'),
          ('null', 1, now(), '{"workspaceId":"state-workspace","durationMs":null}'),
          ('bad-json', 1, now(), '"not json"'),
          ('other-search', 1, now(), '{"workspaceId":"other-workspace","durationMs":900}');
        insert into usage_events values ('usage', now(), 'current-run', 'extract', 'test', '{}', 10, 5, 0.005);
      `);
      const state = await getWorkspaceState(args, tx as unknown as SqlClient);
      expect(workspaceStateSchema.parse(state)).toEqual(state);
      // Corpus excludes the superseded version and in-flight work; stage-name statuses count as processing.
      expect(state.documents).toMatchObject({ total: 1, completed: 1, queued: 2, processing: 1, failed: 0, unknownPageCount: 0 });
      expect(state.pages).toEqual({ total: 3, indexed: 2, notIndexed: 1, basis: "text-searchable-unique-pages" });
      expect(state.storage).toMatchObject({ sourceMb: 2, documentsWithUnknownSize: 0 });
      expect(state.searches).toEqual({ total: 4, recentCount: 4, recentZeroResultCount: 1, latencyMs: { sampleCount: 2, p50: 200, p95: 290, max: 300 } });
      expect(state.performance).toMatchObject({ completedRuns: 1, completedPages: 3, pagesPerMinute: 3 });
      expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, costCents: 0.005 });
      const empty = await getWorkspaceState({ ...args, workspaceId: "empty" }, tx as unknown as SqlClient);
      expect(empty.pages).toMatchObject({ total: 0, indexed: 0, notIndexed: 0 });
      expect(empty.searches.latencyMs).toEqual({ sampleCount: 0, p50: null, p95: null, max: null });
      expect(empty.performance.pagesPerMinute).toBeNull();
    });
  });
});
