import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultPageRouterConfig, routePlanSchema } from '../../packages/shared/dist/index.js';
import { RoutePagesStage } from '../../worker/src/stages/route-pages.ts';
import { WorkflowState } from '../../worker/src/pipeline/pipeline.ts';
import { PdfRasterCache } from '../../worker/src/pipeline/pdf-asset-cache.ts';
import { RoutingLayoutObserver, readLayoutObserverConfig } from '../../worker/src/layout/routing-observer.ts';
import { CommandRunner } from '../../worker/src/tools/runner.ts';
import { buildRuntimeCatalog } from '../../worker/src/routing/runtime.ts';
const [out, scanPdf] = process.argv.slice(2);
if(!out || !scanPdf)throw new Error('output directory and scan PDF required');
await mkdir(out,{recursive:true});
const config=readLayoutObserverConfig(process.env)!;
assert(config);
const files=['worker/testdata/pdf-fixtures/kreuzberg-tables-invoice.pdf','worker/testdata/pdf-fixtures/kreuzberg-formulas-math.pdf',scanPdf];
const samples:any[]=[];
const canonical=(plan:any)=>{const {createdAt,...rest}=plan;return rest;};
for(let block=-1;block<5;block++){
 for(const filename of files){
  const sourceBytes=await readFile(filename);const sha256=createHash('sha256').update(sourceBytes).digest('hex');const id=path.basename(filename,'.pdf');const reference:any[]=[];const router=filename===scanPdf?'baseline':'heuristic';
  for(const arm of block%2===0?['off','shadow']:['shadow','off']){
   const runId=`router-local-${block}-${id}`;const doc:any={id,userId:'local-eval-user',filename:path.basename(filename),mimeType:'application/pdf',pageCount:1,sourceKey:filename,status:'ready'};
   const directory=path.join(out,`block-${block}`,id,arm);await mkdir(directory,{recursive:true});
   const counters={getBytes:0,putBytes:0,putJson:0};const data=new Map<string,Buffer>();
   const storage:any={bucket:'local-measurement',uri:(key:string)=>`s3://local-measurement/${key}`,objectSize:async(key:string)=>data.get(key)?.length??null,
    putBytes:async(key:string,bytes:Buffer)=>{counters.putBytes++;data.set(key,bytes);await writeFile(path.join(directory,'raster.png'),bytes)},
    getBytes:async(key:string)=>{counters.getBytes++;assert(data.has(key));return data.get(key)},
    putJson:async(key:string,value:any)=>{counters.putJson++;data.set(key,Buffer.from(JSON.stringify(value)));await writeFile(path.join(directory,key.includes('layout-shadow')?'layout.json':'plan.json'),JSON.stringify(value,null,2));},
    getJson:async(key:string)=>data.has(key)?JSON.parse(data.get(key)!.toString()):null};
   const sources:any={get:async()=>({path:path.resolve(filename),sha256,sizeBytes:sourceBytes.length,cacheHit:true})};
   const runner=new CommandRunner();const rasterCache=new PdfRasterCache(runner,storage,sources,{engine:'native-pdf'});
   const state=WorkflowState.create({id:runId,orgId:'local-eval-org',workspaceId:'local-eval-workspace',spentCents:0,artifacts:{},stats:{},pipeline:{privacyMode:'local-only',pageRouter:{...defaultPageRouterConfig,router,mode:'shadow'}}} as any,[doc]);
   const stage=new RoutePagesStage(storage,{pageRouterMode:'shadow'} as any,sources,runner,{catalog:()=>buildRuntimeCatalog({privacyMode:'local-only'}),...(arm==='shadow'?{layoutObserver:new RoutingLayoutObserver(config),rasterCache}:{})});
   const cpu=process.cpuUsage();const at=performance.now();await stage.run(state);const ms=performance.now()-at;const used=process.cpuUsage(cpu);
   const plan=routePlanSchema.parse(JSON.parse(await readFile(path.join(directory,'plan.json'),'utf8')));
   assert(!state.pendingPerformance.some(p=>p.metric==='page-route-error'));
   assert(plan.assignments.length > 0, 'Nonempty document must receive an assignment');
   reference.push(canonical(plan));
   const summary=state.pendingPerformance.find(p=>p.metric==='page-route-layout'&&p.scope==='document')?.metadata;
   if(arm==='shadow'){assert.equal(summary?.errors,0);assert.equal(summary?.observed, filename===scanPdf?1:0);}
   const events=state.usageLedger.snapshot();assert(events.every(e=>e.provider!=='openrouter'&&!(e.inputTokens??0)&&!(e.outputTokens??0)));
   const sample={block,arm,router,id,sha256,ms,nodeCpuMs:(used.user+used.system)/1000,counters,summary,events,performance:state.pendingPerformance,assignments:plan.assignments};samples.push(sample);
   await writeFile(path.join(directory,'receipt.json'),JSON.stringify(sample,null,2));
  }
  assert.deepEqual(reference[0],reference[1]);
 }
}
await writeFile(path.join(out,'stage-results.json'),JSON.stringify({observedAt:new Date().toISOString(),scope:'Actual RoutePagesStage with native probe/raster and resident Tiny. Local filesystem artifact adapter, no database, S3, Temporal scheduling or downstream extraction. Both arms include optimized probe. Explicit scenario matrix: heuristic router for native inputs, baseline router for raster scan; each pair uses identical policy. No cross-policy speed comparison. Block -1 is warmup.',node:process.version,config,planParity:true,samples},null,2));
console.log(JSON.stringify(samples.map(({block,arm,id,ms,counters,summary})=>({block,arm,id,ms,counters,summary})),null,2));
