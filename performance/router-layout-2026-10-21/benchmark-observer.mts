import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, release, totalmem } from 'node:os';
import assert from 'node:assert/strict';
import { detectImageLayoutAtEndpoint } from '../../worker/src/layout/image-layout.ts';
import { RoutingLayoutObserver, readLayoutObserverConfig } from '../../worker/src/layout/routing-observer.ts';
const out = process.argv[2];
if (!out) throw new Error('output directory required');
await mkdir(out, {recursive:true});
const config = readLayoutObserverConfig({PAGE_ROUTER_LAYOUT:'shadow', PAGE_ROUTER_LAYOUT_ENDPOINT:'http://127.0.0.1:18769/layout', PAGE_ROUTER_LAYOUT_MODEL_ID:'PaddlePaddle/PP-DocLayout-S', PAGE_ROUTER_LAYOUT_REVISION:'8ac289e66575bb9bba6e15c53719d8b15cc9b3b2', PAGE_ROUTER_LAYOUT_ARTIFACT_SHA256:'e3f62a17e6d5a3e8334e979001a69bdc3c79bc45a55c0d6a98f33e657903b327', PAGE_ROUTER_LAYOUT_TIMEOUT_MS:'10000', PAGE_ROUTER_LAYOUT_PROFILE_SHA256:process.env.PAGE_ROUTER_LAYOUT_PROFILE_SHA256})!;
const ids=['maple-lantern-1994-takeout-menu','business-meridian-invoice-1','scientific-phase-and-oscillation','instruments-rainfall-field-log'];
const inputs=await Promise.all(ids.map(async id=>{const path=`/home/dan/data/docslurp-evals/layout-synthetic-v2/images/${id}.png`;const bytes=await readFile(path);return{id,path,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};}));
const semantic = (r:any)=>{const {diagnostics,...rest}=r;return rest;};
const reference=new Map();
for (const input of inputs) {
 const r=await detectImageLayoutAtEndpoint(input.bytes,config);reference.set(input.id,semantic(r));
 await writeFile(`${out}/${input.id}.prediction.json`,JSON.stringify(r,null,2));
}
const samples:any[]=[];
for(let block=0;block<5;block++) {
 const observer=new RoutingLayoutObserver(config);
 for(const arm of block%2?['cached','direct']:['direct','cached']) {
  const cpu=process.cpuUsage();const started=performance.now();let requests=0;
  for(let repeat=0;repeat<3;repeat++) for(const input of inputs) {
   const at=performance.now();let result:any;let hit=false;
   if(arm==='direct'){result=await detectImageLayoutAtEndpoint(input.bytes,{...config,onRequest:()=>requests++});}
   else {const r=await observer.observe({scopeKey:`local-dev:block-${block}`,payload:input.bytes,onRequest:()=>requests++});result=r.result;hit=r.cacheHit;assert.equal(hit,repeat>0);}
   assert.deepEqual(semantic(result),reference.get(input.id));
   samples.push({block,arm,repeat,id:input.id,ms:performance.now()-at,cacheHit:hit});
  }
  const cpuUsed=process.cpuUsage(cpu);
  samples.push({block,arm,summary:true,requests,completed:12,ms:performance.now()-started,nodeCpuMs:(cpuUsed.user+cpuUsed.system)/1000,rssBytes:process.memoryUsage().rss});
  assert.equal(requests,arm==='direct'?12:4);
 }
}
await writeFile(`${out}/observer-results.json`,JSON.stringify({observedAt:new Date().toISOString(),scope:'Local resident layout transport + observer only; forced 2/3 repeated page reuse. No router/OCR/VLM saving claim. Node CPU excludes Python service.',config,environment:{node:process.version,os:release(),cpu:cpus()[0]?.model,totalmem:totalmem()},inputs:inputs.map(({bytes,...r})=>({...r,bytes:bytes.length})),warmupRequests:4,blocks:5,sourceParity:true,samples},null,2));
console.log(JSON.stringify(samples.filter(s=>s.summary),null,2));
