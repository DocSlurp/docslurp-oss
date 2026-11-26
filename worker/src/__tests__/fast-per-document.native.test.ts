import postgres from "postgres";
import { BILLABLE_UNIT_METRICS, PAGE_READ_METRICS, UNIT_CHARGE_PROVIDER, unitChargeMetadata } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FAST_PER_DOCUMENT_SLOT, PAGE_BILLING_RULES_SLOT, chargeDocumentsFastStatement, recordPageBaseFee } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { loadRunState } from "../pipeline/stage-execution.js";

/**
 * The per-document Fast charge on a real Postgres, with real concurrent transactions (separate connections), and its cost at
 * 10,000 documents. Needs a migrated throwaway database: NATIVE_PG_TESTS=1 DATABASE_URL=postgres://.../docslurp_<name>.
 */
const url = process.env.DATABASE_URL ?? "";
const enabled = process.env.NATIVE_PG_TESTS === "1" && url !== "";
// The CI job sets both; a job that silently skipped would pass with nothing tested.
if (process.env.CI && process.env.NATIVE_PG_TESTS === "1" && !enabled) throw new Error("NATIVE_PG_TESTS=1 needs DATABASE_URL");
vi.spyOn(console, "warn").mockImplementation(() => undefined);

type Sql = postgres.Sql<Record<string, unknown>>;
let admin: Sql;
const stores: Store[] = [];
const prefix = `fpd${Date.now().toString(36)}`;
const newStore = () => {
  const store = new Store(url, 60_000, { poolMax: 2, runEvents: { flushMs: 120_000, maxBuffered: 50_000 } });
  stores.push(store);
  return store;
};
const sqlOf = (store: Store) => (store as unknown as { sql: Sql }).sql;

async function seedRun(runId: string, documents: number, pages: number, options: { perDocument?: boolean; reads?: number; org?: string } = {}) {
  const org = options.org ?? `${prefix}-o1`;
  const artifacts = options.perDocument === false ? { [PAGE_BILLING_RULES_SLOT]: "test" } : { [FAST_PER_DOCUMENT_SLOT]: "1", [PAGE_BILLING_RULES_SLOT]: "test" };
  await admin`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, execution_generation, artifacts, monthly_reservation_cents)
    values (${runId}, ${org}, ${`${prefix}-u1`}, ${`${org}-w`}, 'upload', 'processing', 'embed', '{}', ${documents}, 'g1', ${admin.json(artifacts)}, 1)`;
  await admin`
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count)
    select ${runId} || '-d' || n, ${org}, ${`${prefix}-u1`}, ${`${org}-w`}, ${runId}, 'f' || n || '.pdf', 'application/pdf', 'raw/' || n, 'completed', ${pages}, 'counted', ${pages}
    from generate_series(1, ${documents}) n`;
  if (options.reads) {
    // `reads` page reads spread over the documents (pages 1.. of each), as the usage ledger writes them (rich:<run>:<doc>:<page>).
    const perDocument = Math.ceil(options.reads / documents);
    await admin`
      insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, input_tokens, output_tokens, metadata, org_id, project_id)
      select 'rich:' || ${runId} || ':' || ${runId} || '-d' || n || ':' || p, ${`${prefix}-u1`}, ${runId}, ${UNIT_CHARGE_PROVIDER}, 'price-card', ${BILLABLE_UNIT_METRICS.richPage}, 1, 'page', 1, 0, 0,
        jsonb_build_object('unitCharge', true, 'billable', true, 'documentId', ${runId} || '-d' || n, 'pageNumber', p, 'runId', ${runId}::text),
        ${org}, ${`${org}-w`}
      from generate_series(1, ${documents}) n, generate_series(1, ${perDocument}) p
      where (n - 1) * ${perDocument} + p <= ${options.reads}`;
  }
}

const fastRows = async (runId: string) => admin<{ id: string; amount: string }[]>`
  select id, amount::text from usage_events where run_id = ${runId} and metric = ${BILLABLE_UNIT_METRICS.fastPage} order by id`;

/** A transaction held open after `work` until `release()`: the other connection's statement runs while it is in flight. */
function held(sql: Sql, work: (tx: Sql) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const done = sql.begin(async (tx) => {
    const result = await work(tx as unknown as Sql);
    ready();
    await gate;
    return result;
  });
  return { started, release, done };
}

/** Whether `pid`'s backend is waiting on a lock (the other transaction blocks it). */
async function waitingOnLock(): Promise<boolean> {
  const rows = await admin<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
  return (rows[0]?.n ?? 0) > 0;
}
async function untilBlocked() {
  for (let i = 0; i < 200; i++) {
    if (await waitingOnLock()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the second transaction never waited on the first");
}

describe.skipIf(!enabled)("per-document Fast charge on a real Postgres", () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 2, onnotice: () => undefined });
    await admin`insert into "user"(id, name, email) values (${`${prefix}-u1`}, 'A', ${`${prefix}@example.com`})`;
    for (const org of [`${prefix}-o1`, `${prefix}-o2`]) {
      await admin`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values (${org}, 'Org', ${org}, ${`${prefix}-u1`}, 1000000)`;
      await admin`insert into projects(id, org_id, user_id, name) values (${`${org}-w`}, ${org}, ${`${prefix}-u1`}, 'W')`;
    }
  }, 120_000);

  afterAll(async () => {
    for (const store of stores) await store.close();
    await admin?.end();
  }, 60_000);

  it("two workers completing the same document at once: one charge (real concurrent transactions)", { timeout: 60_000 }, async () => {
    const runId = `${prefix}-race`;
    await seedRun(runId, 1, 7);
    const [a, b] = [newStore(), newStore()];
    const stateA = await loadRunState(a, runId);
    const stateB = await loadRunState(b, runId);
    const documentId = `${runId}-d1`;
    const first = held(sqlOf(a), async (tx) => await chargeDocumentsFastStatement(tx, stateA, { documentId }, { accrue: true })!);
    await first.started;
    // The second insert waits on the first's uncommitted primary key, then inserts nothing.
    const second = chargeDocumentsFastStatement(sqlOf(b), stateB, { documentId }, { accrue: true })!.then((rows) => rows);
    await untilBlocked();
    first.release();
    const [rowsA, rowsB] = await Promise.all([first.done, second]);
    expect((rowsA as Array<{ documents: number }>)[0]!.documents + rowsB[0]!.documents).toBe(1);
    expect(await fastRows(runId)).toEqual([{ id: `fast:${runId}:${documentId}`, amount: "7" }]);
    const debits = await admin<{ n: string }[]>`select count(*)::text as n from credit_debits_pending where run_id = ${runId} and credits > 0`;
    expect(debits[0]!.n).toBe("1");
  });

  it("an index completion racing the completion sweep: each document once", { timeout: 60_000 }, async () => {
    const runId = `${prefix}-sweep`;
    await seedRun(runId, 3, 2);
    const [a, b] = [newStore(), newStore()];
    const stateA = await loadRunState(a, runId);
    const stateB = await loadRunState(b, runId);
    const sweep = held(sqlOf(a), async (tx) => await chargeDocumentsFastStatement(tx, stateA, "run", { accrue: false })!);
    await sweep.started;
    const single = chargeDocumentsFastStatement(sqlOf(b), stateB, { documentId: `${runId}-d2` }, { accrue: true })!.then((rows) => rows);
    await untilBlocked();
    sweep.release();
    await Promise.all([sweep.done, single]);
    expect((await fastRows(runId)).map((row) => row.amount)).toEqual(["2", "2", "2"]);
  });

  it("an older worker's run-wide charge racing an uncommitted per-document charge is refused once that commits", { timeout: 60_000 }, async () => {
    const runId = `${prefix}-rollback`;
    await seedRun(runId, 2, 3);
    const [a, b] = [newStore(), newStore()];
    const stateA = await loadRunState(a, runId);
    const stateB = await loadRunState(b, runId);
    const perDocument = held(sqlOf(a), async (tx) => await chargeDocumentsFastStatement(tx, stateA, { documentId: `${runId}-d1` }, { accrue: true })!);
    await perDocument.started;
    const older = persistRunUsageEvents({ client: sqlOf(b), state: stateB, usageEvents: [{
      id: `fast:${runId}`, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.fastPage, amount: 6, unit: "page", costCents: 6,
      metadata: unitChargeMetadata({ pages: 6, pageRules: 2 }),
    }] }).then(() => "inserted", (error: Error) => error.message);
    await untilBlocked();
    perDocument.release();
    await perDocument.done;
    expect(await older).toMatch(/bills Fast per document/);
    expect((await fastRows(runId)).map((row) => row.id)).toEqual([`fast:${runId}:${runId}-d1`]);
  });

  it("measures 10,000 documents, with and without 100,000 page reads", { timeout: 600_000 }, async () => {
    const store = newStore();
    const sql = sqlOf(store);
    const report: Record<string, string> = {};
    const time = async (label: string, fn: () => Promise<unknown>) => {
      const started = performance.now();
      await fn();
      report[label] = `${(performance.now() - started).toFixed(0)} ms`;
    };
    for (const reads of [0, 100_000]) {
      const tag = reads ? "with 100k reads" : "no reads";
      const before = `${prefix}-before${reads}`;
      const after = `${prefix}-after${reads}`;
      await seedRun(before, 10_000, 20, { perDocument: false, reads });
      await seedRun(after, 10_000, 20, { reads });
      await admin`analyze documents`;
      await admin`analyze usage_events`;
      const beforeState = await loadRunState(store, before);
      await time(`run-wide completion charge, grouped read query (${tag})`, () => recordPageBaseFee(sql, beforeState));
      const afterState = await loadRunState(store, after);
      // One document's statement, as it rides each index completion (1,000 documents, one at a time).
      const started = performance.now();
      for (let n = 1; n <= 1_000; n++) {
        await chargeDocumentsFastStatement(sql, afterState, { documentId: `${after}-d${n}` }, { accrue: true })!;
      }
      report[`after: one document's charge at completion, mean of 1,000 (${tag})`] = `${((performance.now() - started) / 1_000).toFixed(2)} ms`;
      await time(`after: completion sweep, 9,000 documents uncharged (${tag})`, async () => chargeDocumentsFastStatement(sql, afterState, "run", { accrue: false })!);
      await time(`after: completion sweep, every document already charged (${tag})`, async () => chargeDocumentsFastStatement(sql, afterState, "run", { accrue: false })!);
      await time(`after: run_measured_pages, every document charged (${tag})`, () => admin`select * from run_measured_pages(${after}, ${[...PAGE_READ_METRICS]}::text[], null)`);
      const [{ pages }] = await admin<{ pages: string }[]>`select coalesce(sum(amount), 0)::text as pages from usage_events where run_id = ${after} and metric = ${BILLABLE_UNIT_METRICS.fastPage}`;
      const [{ pages: wide }] = await admin<{ pages: string }[]>`select coalesce(sum(amount), 0)::text as pages from usage_events where run_id = ${before} and metric = ${BILLABLE_UNIT_METRICS.fastPage}`;
      // Both rules bill the same pages: 200,000 less the pages read.
      expect(pages).toBe(String(200_000 - reads));
      expect(wide).toBe(String(200_000 - reads));
    }
    process.stderr.write(`[fast-per-document measurements]\n${Object.entries(report).map(([label, value]) => `  ${label}: ${value}`).join("\n")}\n`);
  });
});
