/**
 * Single-org contention bench for the two hot rows the 2026-10-09 load-test
 * re-run found (docs/scaling-1000-workers.md): credit debits on the org row,
 * and slot claims on the per-org lock. Run against a throwaway Postgres.
 *
 *   BENCH_DATABASE_URL=postgres://… [BENCH_MODE=before|after] [BENCH_CLIENTS=576] [BENCH_OPS=20] \
 *     pnpm --filter worker exec tsx scripts/bench-org-contention.ts
 *
 * `before` debits through debit_org_credits() inside each checkpoint-like
 * transaction (the pre-0030 path); `after` appends a pending debit and lets a
 * background flusher apply them. Slot claims always call acquire_worker_slot()
 * as the database defines it, so run the script against a database migrated to
 * 0029 for the old per-org lock and to 0031 for tokens.
 */
import postgres from "postgres";

const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error("BENCH_DATABASE_URL is required");
const mode = process.env.BENCH_MODE === "before" ? "before" : "after";
const clients = Number(process.env.BENCH_CLIENTS ?? 576);
const ops = Number(process.env.BENCH_OPS ?? 20);
const slots = Number(process.env.BENCH_SLOTS ?? 1000);

const sql = postgres(url, { max: clients + 8, prepare: false, onnotice: () => {} });

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = samples.reduce((s, v) => s + v, 0) / Math.max(1, samples.length);
  return { n: samples.length, meanMs: +mean.toFixed(2), p50Ms: +at(0.5).toFixed(2), p95Ms: +at(0.95).toFixed(2), maxMs: +at(1).toFixed(2) };
}

async function setup() {
  await sql`insert into "user"(id, name, email) values ('bench-u', 'B', 'bench@example.test') on conflict do nothing`;
  await sql`delete from organizations where id = 'bench-org'`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents)
    values ('bench-org', 'Bench', 'bench-org', 'bench-u', ${slots}, 100000000)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('bench-ws', 'bench-org', 'bench-u', 'B') on conflict do nothing`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('bench-run', 'bench-org', 'bench-u', 'bench-ws', 'bulk-upload', 'processing', 'x', '{}') on conflict do nothing`;
  await sql`delete from credit_debits_pending where org_id = 'bench-org'`.catch(() => undefined); // absent before 0030
}

async function billing() {
  const latencies: number[] = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: clients }, async () => {
    for (let i = 0; i < ops; i++) {
      const t = performance.now();
      await sql.begin(async (tx) => {
        // Stand-in for the checkpoint's other writes, then the debit as the last statement.
        await tx`select 1`;
        if (mode === "before") {
          await tx`select * from debit_org_credits('bench-org', 0.0114, 'bench-u', 'usage', '{"runId":"bench-run"}'::jsonb)`;
        } else {
          await tx`select enqueue_org_credit_debit('bench-org', 0.0114, 'bench-u', 'usage', 'bench-run', 'bench-ws', '{}'::jsonb)`;
        }
      });
      latencies.push(performance.now() - t);
    }
  }));
  const wallMs = performance.now() - started;
  let flushMs = 0;
  let flushed = { debits: 0 };
  if (mode === "after") {
    const t = performance.now();
    const [row] = await sql<{ debits: number }[]>`select * from apply_pending_org_debits('bench-org', false)`;
    flushMs = performance.now() - t;
    flushed = { debits: Number(row?.debits ?? 0) };
  }
  return { ...stats(latencies), debitsPerSec: Math.round((clients * ops) / (wallMs / 1000)), wallMs: Math.round(wallMs), flushMs: Math.round(flushMs), flushedDebits: flushed.debits };
}

async function slotClaims() {
  await sql`select release_worker_slot(lease_id) from worker_slot_leases where org_key = 'bench-org'`.catch(async () => {
    await sql`delete from worker_slot_leases where org_key = 'bench-org'`;
  });
  const latencies: number[] = [];
  let granted = 0;
  let denied = 0;
  let peak = 0;
  let live = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: clients }, async (_, c) => {
    for (let i = 0; i < ops; i++) {
      const leaseId = `bench-${c}-${i}-${Math.random().toString(36).slice(2)}`;
      const t = performance.now();
      const [row] = await sql<{ acquired: boolean }[]>`
        select * from acquire_worker_slot('bench-run', 'stage', ${`w${c}`}, ${leaseId}, 60000, 0, 2)`;
      latencies.push(performance.now() - t);
      if (!row?.acquired) { denied += 1; continue; }
      granted += 1;
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.BENCH_HOLD_MS ?? 5)));
      live -= 1;
      await sql`select release_worker_slot(${leaseId})`.catch(() => sql`delete from worker_slot_leases where lease_id = ${leaseId}`);
    }
  }));
  const wallMs = performance.now() - started;
  const [held] = await sql<{ n: number }[]>`select count(*)::int as n from worker_slot_leases where org_key = 'bench-org'`;
  return { ...stats(latencies), claimsPerSec: Math.round((clients * ops) / (wallMs / 1000)), granted, denied, peakClientHeld: peak, cap: slots, leasesLeftHeld: held?.n ?? 0 };
}

await setup();
const result = { mode, clients, ops, billing: await billing(), slotClaims: await slotClaims() };
console.log(JSON.stringify(result, null, 2));
await sql.end();
