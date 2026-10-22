import {readFileSync,writeFileSync} from 'node:fs';
const dir='.cache/summary-eval';
const rows=readFileSync(`${dir}/no-reasoning-matrix.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
const q=(a,p)=>[...a].sort((a,b)=>a-b)[Math.min(a.length-1,Math.ceil(a.length*p)-1)];
function stats(a){return {n:a.length,errors:a.filter(x=>x.error).length,truncated:a.filter(x=>x.finishReason==='length').length,outputTokens:{median:q(a.map(x=>x.usage?.outputTokens??0),.5),max:Math.max(...a.map(x=>x.usage?.outputTokens??0))},latencySeconds:{median:q(a.map(x=>x.elapsedMs/1000),.5),p95:q(a.map(x=>x.elapsedMs/1000),.95),max:Math.max(...a.map(x=>x.elapsedMs/1000))},inputTokensMean:a.reduce((s,x)=>s+(x.usage?.inputTokens??0),0)/a.length,providerUsd:a.reduce((s,x)=>s+(x.usage?.costCents??0)/100,0),explicitSamplingLanguage:a.filter(x=>/excerpt|sampled|selected pages|partial|portion/i.test(x.text??'')).length};}
const grouped=field=>Object.fromEntries([...new Set(rows.map(r=>r[field]))].map(k=>[k,stats(rows.filter(r=>r[field]===k))]));
const report={observedAt:new Date().toISOString(),total:stats(rows),byCap:grouped('cap'),byCandidate:grouped('candidate'),largeDocuments:Object.fromEntries([...new Set(rows.map(r=>r.candidate))].map(k=>[k,stats(rows.filter(r=>r.candidate===k&&r.document.startsWith('catalog')))])),limitations:['Pilot latency excludes S3 reads and embedding. Two repetitions do not estimate production tail latency reliably.','Sampling-language regex is a transparency indicator, not a factuality or retrieval-quality score.','Two related catalogs and three synthetic short documents are not a representative benchmark.']};
writeFileSync(`${dir}/hosted-analysis.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
