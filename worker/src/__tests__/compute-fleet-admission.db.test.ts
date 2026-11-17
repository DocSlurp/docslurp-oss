import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
import { computeAllocationAdmission } from "../db/compute-fleet-store.js";
import { createExtractorPluginHost, setExtractorComputeAllocationAdmission } from "../extractors/plugins.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

// server/db/roles.mjs is outside the worker package: load it at run time (as ocr-escalation-retry.test.ts does) so the
// worker's own build, which compiles src/**, never resolves a server path (the worker image has no server/).
type ReconcileRoleGrants = (client: unknown, options: { roles?: Record<string, string>; log: () => void }) => Promise<unknown>;
async function loadReconcileRoleGrants(): Promise<ReconcileRoleGrants> {
  const rolesModule = pathToFileURL(path.resolve(import.meta.dirname, "../../../server/db/roles.mjs")).href;
  return ((await import(/* @vite-ignore */ rolesModule)) as { reconcileRoleGrants: ReconcileRoleGrants }).reconcileRoleGrants;
}

let sql: ReturnType<typeof postgres>, stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres(); stop=db.stop;
  sql=postgres(db.url,{max:1,prepare:false,onnotice:()=>{}});
  await sql.unsafe("create role docslurp_app nologin; create role docslurp_worker nologin; create role custom_app nologin; create role custom_worker nologin");
  // Model grants inherited from a preexisting custom application's owner default privileges.
  await sql.unsafe("grant select,insert,update,delete on compute_fleets,compute_allocation_reservations to custom_app");
  // Repeat after roles exist, then reconcile both standard and configured role names.
  await sql.unsafe(await readFile(new URL("../../../server/db/migrations/0181_compute_fleet_admission.sql",import.meta.url),"utf8"));
  const [upgrade]=await sql`select has_table_privilege('custom_app','compute_fleets','UPDATE') as cap_write,
    has_table_privilege('custom_app','compute_allocation_reservations','DELETE') as ledger_delete,
    has_table_privilege('custom_app','compute_allocation_reservations','SELECT') as ledger_read`;
  expect(upgrade).toEqual({cap_write:false,ledger_delete:false,ledger_read:false});
  const client={query:async(statement:string,params:unknown[]=[])=>({rows:await sql.unsafe(statement,params as postgres.ParameterOrJSON<never>[])})};
  const reconcileRoleGrants = await loadReconcileRoleGrants();
  await reconcileRoleGrants(client,{log:()=>{}});
  await reconcileRoleGrants(client,{roles:{owner:"postgres",app:"custom_app",worker:"custom_worker",backup:"custom_backup"},log:()=>{}});
},120_000);
afterAll(async()=>{await sql?.end();await stop?.();});
const api=()=>computeAllocationAdmission(sql);
async function fleet(cap=2,enabled=true) { const id=`test:${randomUUID()}`;await sql`insert into compute_fleets(id,max_active,enabled) values(${id},${cap},${enabled})`;return id; }
async function asRole<T>(role:string,work:()=>Promise<T>) {await sql.unsafe(`set role ${role}`);try{return await work();}finally{await sql.unsafe("reset role");}}

describe("durable compute fleet admission",()=>{
  it("retains uncertain reservations across clients and refuses beyond the operator cap",async()=>{
    const f=await fleet(), a=randomUUID(), b=randomUUID(), c=randomUUID();
    await asRole("docslurp_worker",async()=>{
      expect(await api().reserve(f,a)).toEqual({fleetId:f,reservationId:a,clientToken:a});
      expect(await api().reserve(f,a)).toMatchObject({reservationId:a});
      await api().reserve(f,b);
      expect(await api().reserve(f,c)).toBeNull();
      // A fresh admission object cannot forget another client's uncertain allocation.
      expect(await computeAllocationAdmission(sql).reserve(f,c)).toBeNull();
      await api().release(f,b,"not-created");
      expect(await api().reserve(f,c)).toMatchObject({reservationId:c});
    });
    const [count]=await sql`select count(*)::int as n from compute_allocation_reservations where fleet_id=${f} and released_at is null`;
    expect(count.n).toBe(2);
  });

  it("lists only this fleet's unreleased reservations past the minimum age, for reconciliation",async()=>{
    const f=await fleet(3), other=await fleet(1), a=randomUUID(), b=randomUUID(), c=randomUUID(), d=randomUUID();
    await asRole("docslurp_worker",async()=>{
      await api().reserve(f,a); await api().reserve(f,b); await api().reserve(f,c); await api().reserve(other,d);
      await api().allocated(f,a,"i-a");
      await api().release(f,c,"not-created");
      expect(await api().unreleased(f,3600)).toEqual([]);
      const pending=await api().unreleased(f,0);
      expect(pending.map((p)=>[p.reservationId,p.providerId]).sort()).toEqual([[a,"i-a"],[b,null]].sort());
      await expect(api().unreleased("bad fleet",0)).rejects.toThrow(/Invalid/);
    });
  });

  it("records exact allocation identity and keeps released tombstones immutable",async()=>{
    const f=await fleet(1),id=randomUUID();await api().reserve(f,id);
    await asRole("docslurp_worker",async()=>{
      await api().allocated(f,id,"provider-1");await api().allocated(f,id,"provider-1");
      await expect(api().allocated(f,id,"provider-2")).rejects.toThrow();
      await expect(api().release(f,id,"not-created")).rejects.toThrow();
      await expect(api().release("wrong-fleet",id,"provider-deleted")).rejects.toThrow();
      expect(await api().reserve(f,randomUUID())).toBeNull();
      await api().release(f,id,"provider-deleted");await api().release(f,id,"provider-deleted");
      await expect(api().release(f,id,"not-created")).rejects.toThrow("refused");
      await expect(api().reserve(f,id)).rejects.toThrow("cannot be reused");
      await expect(sql`update compute_allocation_reservations set released_at=null,release_reason=null where id=${id}`).rejects.toThrow("immutable");
      await expect(sql`update compute_allocation_reservations set slot=2 where id=${id}`).rejects.toThrow("immutable");
      await expect(sql`delete from compute_allocation_reservations where id=${id}`).rejects.toThrow("permission denied");
    });
  });

  it("does not turn unknown/disabled fleets or malformed identities into an unrestricted allocator",async()=>{
    await expect(api().reserve("unknown",randomUUID())).rejects.toThrow("unavailable");
    await expect(api().reserve(await fleet(1,false),randomUUID())).rejects.toThrow("unavailable");
    for(const f of ["", "a".repeat(201), "fleet/other"])await expect(api().reserve(f,randomUUID())).rejects.toThrow("identity");
    await expect(api().reserve(await fleet(),"invalid")).rejects.toThrow("identity");
    const f=await fleet(),id=randomUUID();await api().reserve(f,id);
    await expect(api().allocated(f,id,"x".repeat(201))).rejects.toThrow();
    await expect(api().release(f,id,"provider-deleted")).rejects.toThrow();
    await expect(api().reserve(await fleet(),id)).rejects.toThrow("cannot be reused");
  });

  it("keeps caps operator-owned and platform records inaccessible to application roles after reconciliation",async()=>{
    const f=await fleet(1);
    for(const role of ["docslurp_app","custom_app"])await asRole(role,async()=>{
      for(const query of ["select * from compute_fleets","select * from compute_allocation_reservations","update compute_fleets set max_active=200"])
        await expect(sql.unsafe(query)).rejects.toThrow("permission denied");
    });
    for(const role of ["docslurp_worker","custom_worker"])await asRole(role,async()=>{
      await expect(sql`update compute_fleets set max_active=200 where id=${f}`).rejects.toThrow("permission denied");
      await expect(sql`delete from compute_fleets where id=${f}`).rejects.toThrow("permission denied");
      await expect(sql`update compute_fleets set id='renamed' where id=${f}`).rejects.toThrow("immutable");
      // Direct SQL inserts still pass through the database cap, not just the TypeScript helper.
      if(role==="docslurp_worker")await sql`insert into compute_allocation_reservations(id,fleet_id) values(${randomUUID()},${f})`;
      await expect(sql`insert into compute_allocation_reservations(id,fleet_id) values(${randomUUID()},${f})`).rejects.toThrow("capacity");
      await expect(sql`insert into compute_allocation_reservations(id,fleet_id,slot) values(${randomUUID()},${f},199)`).rejects.toThrow("begin unallocated");
    });
  });

  it("refuses unbound plugin admission and forwards only after startup binds storage",async()=>{
    setExtractorComputeAllocationAdmission(undefined);
    const host=createExtractorPluginHost();
    await expect(host.computeAllocationAdmission.reserve("fleet",randomUUID())).rejects.toThrow("not bound");
    setExtractorComputeAllocationAdmission(api());
    try {const f=await fleet();expect(await host.computeAllocationAdmission.reserve(f,randomUUID())).toMatchObject({fleetId:f});}
    finally{setExtractorComputeAllocationAdmission(undefined);}
  });
});
