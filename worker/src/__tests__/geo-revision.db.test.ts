import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDatabase } from "../test/migrated-db.js";
let db: PGlite;
beforeAll(async()=>{
 db=await createMigratedDatabase();
 await db.exec(`insert into "user"(id,name,email) values ('u','U','geo@example.com');
 insert into organizations(id,name,slug,created_by_user_id) values('o','O','geo','u');
 insert into workspaces(id,org_id,user_id,name) values('w','o','u','W');
 insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,pipeline) values('r','o','u','w','upload','processing','structured-extract','{}');
 insert into documents(id,org_id,user_id,workspace_id,run_id,filename,mime_type,source_key,status)
 values('d','o','u','w','r','d.txt','text/plain','source','processing');`);
},60000);
afterAll(async()=>{await db?.close();});
async function revision(){return (await db.query<{v:string}>("select projection_revision::text as v from documents where id='d'")).rows[0].v;}
it("operational completion preserves revision, source change invalidates",async()=>{
 const old=await revision();await db.exec("update documents set status='completed',updated_at=now() where id='d'");
 expect(await revision()).toBe(old);
 await db.exec("update documents set source_key='replacement' where id='d'");expect(await revision()).not.toBe(old);
});
it("workspace schema mutation invalidates",async()=>{
 const old=await revision();await db.exec(`update workspaces set pipeline='{"outputSchema":{"type":"object"}}' where id='w'`);
 expect(await revision()).not.toBe(old);
});
it("unavailable PostGIS refuses publication and rolls back source",async()=>{
 await db.exec(`insert into document_run_stage_states(run_id,document_id,stage_name,status,attempts,stats)
 values('r','d','structured-extract','processing',1,'{}');`);
 const rev=await revision();
 await expect(db.query("select commit_geo_final_source('d','w','o',$1,'r',repeat('a',64),repeat('b',64),'[]')",[rev])).rejects.toThrow("spatial migrations");
 expect((await db.query("select * from geo_accepted_sources")).rows).toEqual([]);
});
it("wrong tenant and stale revision refuse before publication",async()=>{
 for (const [org,rev] of [['other',await revision()],['o','-1']])
 await expect(db.query("select commit_geo_final_source('d','w',$1,$2,'r',repeat('a',64),repeat('b',64),'[]')",[org,rev])).rejects.toThrow();
});

it("the actual checkpoint store cannot mark a geo stage complete after publication fails", async()=>{
 const served=await serveOnRandomPort(db);
 const store=new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`,60000,{poolMax:1});
 try {
  const state=await loadRunState(store,"r");
  await expect(store.completeDocumentStage(state,"d","structured-extract","s3://partial",{}, {
   documentId:"d",workspaceId:"w",orgId:"o",runId:"r",revision:await revision(),
   schemaDigest:"a".repeat(64),resultDigest:"b".repeat(64),features:[],
  })).rejects.toThrow("spatial migrations");
  const rows=await db.query<{status:string}>("select status from document_run_stage_states where document_id='d' and stage_name='structured-extract'");
  expect(rows.rows[0].status).toBe("processing");
  expect((await db.query("select * from geo_accepted_sources")).rows).toEqual([]);
 } finally {await store.close();await served.server.stop();}
});
