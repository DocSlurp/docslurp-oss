import { reconcileMediaReceipt } from "./reconcile.js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveChatCreditReserveConfig } from "@docslurp/shared";
import { setChatReserveConfig } from "../db/chat-reserve.js";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
import { PostgresMediaJournal } from "./journal.js";
import { PostgresCapacityLeaseStore } from "./capacity/store.js";
import type { WorkspaceRun } from "../models.js";

describe("remote media admission and accounting on migrated Postgres", () => {
  let db: Awaited<ReturnType<typeof startMigratedPostgres>>;
  let sql: postgres.Sql<Record<string, unknown>>;
  let journal: PostgresMediaJournal;
  const scope = { orgId: "media-org", workspaceId: "media-ws", runId: "media-run", documentId: "media-doc" };
  const args = { scope, key: "request-a", provider: "test", model: "speech", reserveCents: .5,
    maxRunCostCents: 100, maxConcurrent: 1, dailyBudgetCents: 5 };
  beforeAll(async () => {
    // Admission mechanics at small balances, without the chat reserve.
    setChatReserveConfig(resolveChatCreditReserveConfig({ CHAT_CREDIT_RESERVE_CREDITS: "0", CHAT_CREDIT_RESERVE_FREE_CREDITS: "0" }));
    db = await startMigratedPostgres(); sql = postgres(db.url, { max: 1, prepare: false }); journal = new PostgresMediaJournal(sql);
    await sql`insert into "user"(id,name,email) values ('media-u','Media','media-test@example.com')`;
    await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents,included_credits_remaining)
      values ('media-org','Media','media-test','media-u',100,0)`;
    await sql`insert into workspaces(id,org_id,user_id,name) values ('media-ws','media-org','media-u','Media')`;
    await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,pipeline)
      values ('media-run','media-org','media-u','media-ws','bulk-upload','processing','extract-markdown','{}')`;
    await sql`insert into documents(id,user_id,workspace_id,run_id,filename,mime_type,source_key,status)
      values ('media-doc','media-u','media-ws','media-run','sample.wav','audio/wav','source','uploaded')`;
  }, 120000);
  beforeEach(async () => { await sql`delete from media_reconciliation_actions`; await sql`delete from remote_media_jobs`; await sql`delete from media_video_admissions`; await sql`delete from remote_capacity_leases`; await sql`delete from remote_capacity_watchdog`; });
  afterAll(async () => { setChatReserveConfig(null); await sql?.end(); await db?.stop(); });
  it("serializes competing admission, deduplicates retries and retains uncertain reservations", async () => {
    const results = await Promise.allSettled([journal.admit(args), journal.admit({ ...args, key: "request-b" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const admitted = results[0]; expect(admitted.status).toBe("fulfilled");
    if (admitted.status !== "fulfilled") throw new Error("first admission failed");
    await journal.uncertain(admitted.value.receipt.id);
    expect(await journal.admit(args)).toMatchObject({ acquired: false, receipt: { status: "uncertain" } });
    await expect(journal.admit({ ...args, key: "request-c" })).rejects.toThrow("concurrency");
  });
  it("rejects wrong tenant and budget before any provider request", async () => {
    await expect(journal.admit({ ...args, scope: { ...scope, orgId: "other" } })).rejects.toThrow("admission");
    await expect(journal.admit({ ...args, dailyBudgetCents: .1 })).rejects.toThrow("daily budget");
    await expect(journal.admit({ ...args, maxRunCostCents: .1 })).rejects.toThrow("cost cap");
    await expect(journal.admit({...args,maxRunCostCents:0})).rejects.toThrow("cost cap");
    expect((await sql`select * from remote_media_jobs`).length).toBe(0);
  });
  it("holds completed but uncheckpointed costs and blocks discrepant pricing", async () => {
    const admitted = await journal.admit(args);
    await journal.complete(admitted.receipt.id, "result", 99.8);
    await expect(journal.admit({ ...args, key: "next", dailyBudgetCents: 200, maxRunCostCents: 200 })).rejects.toThrow("spend admission");
    await journal.settled(admitted.receipt.id);
    await sql`update remote_media_jobs set pricing_uncertain = true where id = ${admitted.receipt.id}`;
    await expect(journal.admit({ ...args, key: "next" })).rejects.toThrow("pricing requires reconciliation");
    expect(await journal.admit(args)).toMatchObject({ acquired: false, receipt: { status: "completed" } });
  });
  it("counts host reservations against both later hosts and transcription admission", async () => {
    const leases = new PostgresCapacityLeaseStore(sql, async () => null, ["test"]);
    await leases.heartbeat();
    const request = { scope, provider: "test", beforeIds: [], quote: { hourlyUsd: 1, fixedReserveUsd: .8, observedAt: Date.now() },
      ttlMs: 60000, budgetUsd: 5, maxConcurrent: 4, maxRunCostCents: 1000 };
    await leases.reserve(request);
    await expect(leases.reserve(request)).rejects.toThrow("spend admission");
    await expect(journal.admit({ ...args, reserveCents: 30, dailyBudgetCents: 100, maxRunCostCents: 1000 })).rejects.toThrow("spend admission");
  });
  it("requires watchdog readiness and atomically records capacity cost once", async () => {
    const run = { id: "media-run", userId: "media-u", orgId: "media-org", workspaceId: "media-ws", stats: {}, artifacts: {},
      spentCents: 0, pipeline: {} } as WorkspaceRun;
    const leases = new PostgresCapacityLeaseStore(sql, async () => run, ["test"]);
    const request = { scope, provider: "test", beforeIds: ["unrelated"], quote: { hourlyUsd: .3, fixedReserveUsd: .01, observedAt: Date.now() },
      ttlMs: 60000, budgetUsd: 1, maxConcurrent: 1, maxRunCostCents: 100 };
    await expect(leases.reserve(request)).rejects.toThrow("watchdog");
    await leases.heartbeat(); const lease = await leases.reserve(request);
    await leases.attach(lease.id, "owned"); await leases.deleting(lease.id);
    const cost = await leases.deleted({ ...lease, resourceId: "owned" }, lease.createdAt + 60000);
    expect(cost).toBeCloseTo(.005);
    await leases.deleted(lease, lease.createdAt + 120000);
    expect(await leases.outstanding()).toHaveLength(0);
    const rows = await sql`select org_id,workspace_id,run_id,cost_cents from usage_events where id = ${lease.id}`;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ org_id: scope.orgId, workspace_id: scope.workspaceId, run_id: scope.runId });
    expect(Number(rows[0].cost_cents)).toBeCloseTo(.5);
  });
  it("reserves Free video quotas atomically and does not count a retry twice", async () => {
    await sql`insert into documents(id,user_id,workspace_id,run_id,filename,mime_type,source_key,status)
      values ('media-doc-2','media-u','media-ws','media-run','second.mp4','video/mp4','second','uploaded') on conflict do nothing`;
    const results=await Promise.allSettled([journal.admitVideo(scope,400,40),journal.admitVideo({...scope,documentId:"media-doc-2"},400,40)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const [admission]=await sql`select * from media_video_admissions`;
    await journal.admitVideo({...scope,documentId:admission.document_id},400,40);
    expect(await sql`select * from media_video_admissions`).toHaveLength(1);
    await expect(journal.admitVideo(scope,601,60)).rejects.toThrow("tier");
  });
  it("reconciles matching request evidence idempotently without a second usage debit",async()=>{
    const admission=await journal.admit(args);
    await journal.complete(admission.receipt.id,"result",.001665,false,{state:"disputed",basis:"input-seconds",rateVersion:"test",rateSource:"test",estimatedCostUsd:.00001665,reportedCostUsd:.001665,providerRequestId:"provider-id"});
    await journal.settled(admission.receipt.id);
    const evidence={providerRequestId:"provider-id",costNanoUsd:16650,reference:"provider request invoice",actor:"operator"};
    expect(await reconcileMediaReceipt(sql,admission.receipt.id,evidence)).toMatchObject({apply:false});
    expect(await sql`select * from media_reconciliation_actions`).toHaveLength(0);
    await reconcileMediaReceipt(sql,admission.receipt.id,evidence,true);await reconcileMediaReceipt(sql,admission.receipt.id,evidence,true);
    expect(await sql`select * from media_reconciliation_actions`).toHaveLength(1);
    expect((await sql`select cost_state from remote_media_jobs`)[0].cost_state).toBe("reconciled");
    await expect(reconcileMediaReceipt(sql,admission.receipt.id,{...evidence,costNanoUsd:1},true)).rejects.toThrow("billing correction");
  });

  it("rejects a zero run budget before creating a host lease", async () => {
    const leases=new PostgresCapacityLeaseStore(sql,async()=>null,["test"]);await leases.heartbeat();
    await expect(leases.reserve({scope,provider:"test",beforeIds:[],quote:{hourlyUsd:.1,fixedReserveUsd:0,observedAt:Date.now()},ttlMs:60000,budgetUsd:1,maxConcurrent:1,maxRunCostCents:0})).rejects.toThrow("run admission");
    expect(await leases.outstanding()).toHaveLength(0);
  });

});
