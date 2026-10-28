import { randomUUID } from "node:crypto";
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

// Optional real PostgreSQL seam against a fully migrated database: seeds
// uniquely named tenants inside one transaction and rolls it back, so the
// corpus-stats triggers and the usage_attribution view run as in production.
const integrationUrl = process.env.WORKSPACE_STATE_TEST_DATABASE_URL;
const client = integrationUrl ? postgres(integrationUrl, { max: 1, onnotice: () => {} }) : null;
afterAll(async () => { await client?.end(); });

class Rollback extends Error {}

describe.skipIf(!client)("workspace state PostgreSQL aggregates", () => {
  it("deduplicates searchable pages, excludes other tenants and history, and handles bad metadata", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const id = (name: string) => `${name}-${suffix}`;
    const ws = id("state-workspace");
    const otherWs = id("other-workspace");
    const args = { workspaceId: ws, orgId: id("state-org"), recentWindowHours: 24 };
    const seed = `
        insert into "user" (id, name, email) values ('{user}', 'State Owner', '{user}@example.test');
        insert into organizations (id, name, slug) values ('{state-org}', 'State Org', '{state-org}'), ('{other-org}', 'Other Org', '{other-org}');
        insert into workspaces (id, org_id, user_id, name) values
          ('{state-workspace}', '{state-org}', '{user}', 'State'),
          ('{other-workspace}', '{other-org}', '{user}', 'Other');
        insert into workspace_runs (id, workspace_id, org_id, user_id, kind, stage, status, pages_processed, created_at, updated_at) values
          ('{current-run}', '{state-workspace}', '{state-org}', '{user}', 'bulk-upload', 'completed', 'completed', 3, now() - interval '1 minute', now()),
          ('{old-run}', '{state-workspace}', '{state-org}', '{user}', 'bulk-upload', 'completed', 'completed', 3, now() - interval '3 days', now() - interval '3 days' + interval '1 minute'),
          ('{other-run}', '{other-workspace}', '{other-org}', '{user}', 'bulk-upload', 'completed', 'completed', 900, now() - interval '1 minute', now());
        insert into documents (id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, file_size, metadata, superseded_at) values
          ('{doc}', '{user}', '{state-workspace}', '{current-run}', 'doc.pdf', 'application/pdf', 'raw/{doc}', 'completed', 3, 2000000, '{"sourceSizeMeasured":true}', null),
          ('{superseded}', '{user}', '{state-workspace}', '{old-run}', 'old.pdf', 'application/pdf', 'raw/{superseded}', 'completed', 4, 1000000, '{"sourceSizeMeasured":true}', now()),
          ('{pending}', '{user}', '{state-workspace}', '{current-run}', 'pending.pdf', 'application/pdf', 'raw/{pending}', 'queued', 2, 0, '{}', null),
          ('{unknown}', '{user}', '{state-workspace}', '{current-run}', 'unknown.pdf', 'application/pdf', 'raw/{unknown}', 'queued', 0, 0, '{}', null),
          ('{staged}', '{user}', '{state-workspace}', '{current-run}', 'staged.pdf', 'application/pdf', 'raw/{staged}', 'embed', 1, 0, '{}', null),
          ('{other}', '{user}', '{other-workspace}', '{other-run}', 'other.pdf', 'application/pdf', 'raw/{other}', 'completed', 900, 9000000, '{}', null);
        insert into document_pages (id, document_id, run_id, user_id, page_number, text) values
          ('{page1}', '{doc}', '{current-run}', '{user}', 1, 'one'),
          ('{duplicate}', '{doc}', '{current-run}', '{user}', 1, 'one'),
          ('{old-page}', '{doc}', '{old-run}', '{user}', 3, 'old'),
          ('{superseded-page}', '{superseded}', '{old-run}', '{user}', 4, 'replaced version'),
          ('{other-page}', '{other}', '{other-run}', '{user}', 1, 'other'),
          ('{queued-page}', '{pending}', '{current-run}', '{user}', 1, 'not searchable yet'),
          ('{empty-page}', '{doc}', '{current-run}', '{user}', 3, '   ');
        insert into document_chunks (id, document_id, run_id, user_id, chunk_index, page_number, parent_page_id, text) values
          ('{chunk1}', '{doc}', '{current-run}', '{user}', 0, 1, null, 'chunk1'),
          ('{chunk2}', '{doc}', '{current-run}', '{user}', 1, 1, null, 'chunk2'),
          ('{chunk3}', '{doc}', '{current-run}', '{user}', 2, 2, null, 'chunk3'),
          ('{invalid}', '{doc}', '{current-run}', '{user}', 3, 99, null, 'invalid'),
          ('{pending-chunk}', '{pending}', '{current-run}', '{user}', 0, 2, null, 'not searchable yet');
        insert into search_sessions (id, user_id, query, result_count, created_at, metadata) values
          ('{numeric}', '{user}', 'q', 1, now(), '{"workspaceId":"{state-workspace}","durationMs":100}'),
          ('{multi}', '{user}', 'q', 0, now(), '{"workspaceIds":["{state-workspace}","{other-workspace}"],"durationMs":300}'),
          ('{bad-number}', '{user}', 'q', 1, now(), '{"workspaceId":"{state-workspace}","durationMs":"invalid"}'),
          ('{null}', '{user}', 'q', 1, now(), '{"workspaceId":"{state-workspace}","durationMs":null}'),
          ('{bad-json}', '{user}', 'q', 1, now(), '"not json"'),
          ('{other-search}', '{user}', 'q', 1, now(), '{"workspaceId":"{other-workspace}","durationMs":900}');
        -- Stamped with its tenant columns, as the usage ledgers write it (migration 0042).
        insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, input_tokens, output_tokens, cost_cents, metadata, org_id, workspace_id) values
          ('{usage}', '{user}', '{current-run}', 'test', 'm', 'extract', 15, 'token', 10, 5, 0.005, '{"runId":"{current-run}"}', '{state-org}', '{state-workspace}'),
          ('{other-usage}', '{user}', '{other-run}', 'test', 'm', 'extract', 1000, 'token', 900, 100, 9, '{"runId":"{other-run}"}', '{other-org}', '{other-workspace}');
      `.replace(/\{([a-z0-9-]+)\}/g, (_match, name: string) => id(name));
    try {
      await client!.begin(async (tx) => {
        await tx.unsafe(seed);
        const state = await getWorkspaceState(args, tx as unknown as SqlClient);
        expect(workspaceStateSchema.parse(state)).toEqual(state);
        // Corpus excludes the superseded version and in-flight work; stage-name statuses count as processing.
        expect(state.documents).toMatchObject({ total: 1, completed: 1, queued: 2, processing: 1, failed: 0, unknownPageCount: 0 });
        expect(state.pages).toEqual({ total: 3, indexed: 2, notIndexed: 1, basis: "text-searchable-unique-pages" });
        expect(state.storage).toMatchObject({ sourceMb: 2, documentsWithUnknownSize: 0 });
        expect(state.searches).toEqual({ total: 4, recentCount: 4, recentZeroResultCount: 1, latencyMs: { sampleCount: 2, p50: 200, p95: 290, max: 300 } });
        expect(state.performance).toMatchObject({ completedRuns: 1, completedPages: 3, pagesPerMinute: 3 });
        expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, costCents: 0.005 });
        const empty = await getWorkspaceState({ ...args, workspaceId: id("empty") }, tx as unknown as SqlClient);
        expect(empty.pages).toMatchObject({ total: 0, indexed: 0, notIndexed: 0 });
        expect(empty.searches.latencyMs).toEqual({ sampleCount: 0, p50: null, p95: null, max: null });
        expect(empty.performance.pagesPerMinute).toBeNull();
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });
});
