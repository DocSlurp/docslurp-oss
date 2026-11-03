import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { RealtimeBroker, type DashboardResource } from "./broker.js";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let backend: typeof import("./backend.js").realtimeBackend;
let collecting=false;
let statements=0;
beforeAll(async()=>{
  const pg=await startMigratedPostgres();stop=pg.stop;
  sql=postgres(pg.url,{max:1,prepare:false,onnotice:()=>{},debug:()=>{if(collecting) statements++;}});
  vi.doMock("../db.js",()=>({sql}));
  vi.doMock("../lib/auth.js",()=>({auth:{api:{getSession:async()=>null}},appDbPool:{}}));
  backend=(await import("./backend.js")).realtimeBackend;
  await sql`insert into "user"(id,name,email) values('load-owner','Test','load@example.test')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values('load-org','Test','load','load-owner')`;
  await sql`insert into org_memberships(org_id,user_id,role) values('load-org','load-owner','owner') on conflict do nothing`;
  await sql`insert into workspaces(id,org_id,user_id,name) values('load-w','load-org','load-owner','Test')`;
  for(let n=0;n<10;n++) await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage)
    values(${`load-${n}`},'load-org','load-owner','load-w','upload','processing','vision-extract')`;
},120000);
afterAll(async()=>{await sql?.end();await stop?.();});

it("measures the frozen matched local workload without provider calls",async()=>{
  const output=[];
  for(const scenario of ["idle","burst","ten-run","reconnect"]){
    const arms=[];
    for(const arm of ["sse-policy","broker"]){
      await sql`update workspace_runs set total_documents=0,updated_at='2026-01-01T00:00:00Z' where workspace_id='load-w'`;
      const resources: DashboardResource[]=Array.from({length:scenario==="idle"||scenario==="burst"?1:10},(_,n)=>({kind:"run",runId:`load-${n}`}));
      const latest=new Map<string,unknown>();
      let deliveries=0,bytes=0,projections=0,revisionReads=0;
      let peakRss=process.memoryUsage().rss;
      const latencies:number[]=[];
      const measured={...backend,
        project:async(user:string,resource:DashboardResource)=>{projections++;return backend.project(user,resource);},
        revisions:async(ids:string[])=>{revisionReads++;return backend.revisions(ids);},
        listen:async()=>async()=>{},
      };
      const broker=new RealtimeBroker(measured,3600000);
      let detach:Array<()=>void>=[];
      const deliver=(resource:DashboardResource,data:unknown)=>{latest.set(JSON.stringify(resource),data);deliveries++;bytes+=Buffer.byteLength(JSON.stringify(data));};
      const subscribe=async()=>{for(const resource of resources) for(let n=0;n<10;n++) detach.push(await broker.subscribe("load-owner",resource,async data=>{deliver(resource,data);}));};
      statements=0;collecting=true;
      const cpu=process.cpuUsage();const started=performance.now();
      if(arm==="broker") await subscribe();
      let refresh=-100;
      for(let second=0;second<=20;second++){
        collecting=false;
        const burst=scenario==="burst"&&second===5;
        const changed=burst||(scenario==="ten-run"&&(second===5||second===15))||(scenario==="reconnect"&&second===6);
        if(changed) for(let n=0;n<(burst?100:1);n++) await sql`update workspace_runs set total_documents=total_documents+1,updated_at=now() where workspace_id='load-w'`;
        collecting=true;
        if(scenario==="reconnect"&&second===5){detach.forEach(fn=>fn());detach=[];}
        if(scenario==="reconnect"&&second>=5&&second<8) continue;
        const rejoin=scenario==="reconnect"&&second===8;
        if(rejoin&&arm==="broker") await subscribe();
        const tick=performance.now();
        if(arm==="broker") await broker.tick();
        else if(second===0||rejoin||changed||second-refresh>=10){
          for(const resource of resources){const data=await measured.project("load-owner",resource);for(let n=0;n<10;n++)deliver(resource,data);}
          refresh=second;
        }
        if(changed||rejoin) latencies.push(performance.now()-tick);
        peakRss=Math.max(peakRss,process.memoryUsage().rss);
      }
      collecting=false;
      const elapsedMs=performance.now()-started;const usage=process.cpuUsage(cpu);
      for(const resource of resources) expect(latest.get(JSON.stringify(resource))).toEqual(await backend.project("load-owner",resource));
      detach.forEach(fn=>fn());await broker.close();
      const p95Ms=latencies.sort((a,b)=>a-b)[Math.max(0,Math.ceil(latencies.length*.95)-1)]??0;
      arms.push({arm,sqlStatements:statements,projections,revisionReads,deliveries,serializedBytes:bytes,elapsedMs:Math.round(elapsedMs),cpuMs:Math.round((usage.user+usage.system)/1000),peakRssMiB:Math.round(peakRss/1048576),p95WorkMs:Math.round(p95Ms),resourceBudgetPassed:peakRss<1073741824&&bytes<2097152&&p95Ms<2000});
      // Report all frozen budget failures, including the baseline, without truncating the measurement.
    }
    const [baseline,candidate]=arms;
    const queryBudgetPassed=scenario==="idle"?candidate!.sqlStatements<baseline!.sqlStatements:candidate!.sqlStatements<=baseline!.sqlStatements*1.2;
    output.push({scenario,arms,queryBudgetPassed});
  }
  console.log("REALTIME_MATCHED_RESULTS="+JSON.stringify(output));
},120000);
