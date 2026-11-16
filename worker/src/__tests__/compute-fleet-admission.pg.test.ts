/** Real PostgreSQL concurrency gate. Use an explicitly supplied disposable local database. */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAllocationAdmission } from "../db/compute-fleet-store.js";
const url=process.env.TEST_DATABASE_URL;
let sql: ReturnType<typeof postgres>;
beforeAll(async()=>{
  if(!url)return;
  sql=postgres(url,{max:16,prepare:false,onnotice:()=>{}});
  await sql.unsafe(await readFile(new URL("../../../server/db/migrations/0181_compute_fleet_admission.sql",import.meta.url),"utf8"));
});
afterAll(async()=>{await sql?.end();});
async function fleet(cap:number){const id=`concurrency:${randomUUID()}`;await sql`insert into compute_fleets(id,max_active,enabled) values(${id},${cap},true)`;return id;}

describe.skipIf(!url)("real PostgreSQL fleet admission",()=>{
  it("revokes a custom application's inherited default grants before the migration commits",async()=>{
    const suffix=randomUUID().replaceAll("-","");
    const database=`dbtest_fleet_upgrade_${suffix}`,role=`fleet_app_${suffix}`;
    let upgrade:ReturnType<typeof postgres>|undefined;
    // Names are generated locally from UUID hex, never request input.
    await sql.unsafe(`create role "${role}" nologin`);
    await sql.unsafe(`create database "${database}"`);
    try{
      const connection=new URL(url!);connection.pathname=`/${database}`;
      upgrade=postgres(connection.toString(),{max:1,prepare:false,onnotice:()=>{}});
      await upgrade.unsafe(`alter default privileges grant select,insert,update,delete on tables to "${role}"`);
      await upgrade.unsafe(await readFile(new URL("../../../server/db/migrations/0181_compute_fleet_admission.sql",import.meta.url),"utf8"));
      const [row]=await upgrade`select has_table_privilege(${role},'compute_fleets','UPDATE') as cap_write,
        has_table_privilege(${role},'compute_allocation_reservations','DELETE') as ledger_delete,
        has_table_privilege(${role},'compute_allocation_reservations','SELECT') as ledger_read`;
      expect(row).toEqual({cap_write:false,ledger_delete:false,ledger_read:false});
    }finally{
      await upgrade?.end();
      await sql.unsafe(`drop database "${database}"`);
      await sql.unsafe(`drop role "${role}"`);
    }
  });
  it("admits exactly four of 32 simultaneous requests",async()=>{
    const id=await fleet(4), admission=computeAllocationAdmission(sql);
    const results=await Promise.all(Array.from({length:32},()=>admission.reserve(id,randomUUID())));
    expect(results.filter(Boolean)).toHaveLength(4);
    const [row]=await sql`select count(*)::int as n,count(distinct slot)::int as slots from compute_allocation_reservations where fleet_id=${id} and released_at is null`;
    expect(row).toEqual({n:4,slots:4});
  });
  it("does not consume additional slots for simultaneous identical retries",async()=>{
    const f=await fleet(1),id=randomUUID(),admission=computeAllocationAdmission(sql);
    const results=await Promise.all(Array.from({length:16},()=>admission.reserve(f,id)));
    expect(results.every(r=>r?.reservationId===id)).toBe(true);
    expect(await admission.reserve(f,randomUUID())).toBeNull();
  });
  it("rejects a stale policy snapshot after the operator disables or reduces a fleet",async()=>{
    for(const disable of [true,false]){
      const f=await fleet(2);
      await expect(sql.begin("isolation level repeatable read",async tx=>{
        await tx`select * from compute_fleets where id=${f}`;
        await sql`update compute_fleets set enabled=${!disable},max_active=1 where id=${f}`;
        await tx`insert into compute_allocation_reservations(id,fleet_id) values(${randomUUID()},${f})`;
      })).rejects.toMatchObject({code:"40001"});
      const [row]=await sql`select count(*)::int as n from compute_allocation_reservations where fleet_id=${f}`;
      expect(row.n).toBe(0);
    }
  });
  it("rejects stale REPEATABLE READ snapshots through the occupied-slot constraint",async()=>{
    const f=await fleet(1);
    await expect(sql.begin("isolation level repeatable read",async tx=>{
      await tx`select * from compute_allocation_reservations where fleet_id=${f}`;
      await computeAllocationAdmission(sql).reserve(f,randomUUID());
      // Its snapshot cannot see the newly committed reservation, even after taking the advisory lock.
      await tx`insert into compute_allocation_reservations(id,fleet_id) values(${randomUUID()},${f})`;
    })).rejects.toMatchObject({code:"23505",constraint_name:"compute_allocation_occupied_slot"});
    const [row]=await sql`select count(*)::int as n from compute_allocation_reservations where fleet_id=${f}`;
    expect(row.n).toBe(1);
  });
});
