// Offline sampling experiment; never imports these fixture choices into production.
// Run: node --import tsx scripts/summary-eval/compare.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectSummaryInput } from './baseline-selector.ts';
const out = '.cache/summary-eval';
mkdirSync(out, { recursive: true });
const files = [
  ['catalog-2023', '.cache/fixtures/pdf/university-catalogs/boulder-2023-24.pdf'],
  ['catalog-2024', '.cache/fixtures/pdf/university-catalogs/boulder-2024-25.pdf'],
  ['invoice', 'worker/testdata/pdf-fixtures/kreuzberg-tables-invoice.pdf'],
  ['mixed', 'worker/testdata/pdf-fixtures/kreuzberg-mixed-content.pdf'],
  ['academic', 'worker/testdata/pdf-fixtures/academic-latex-ligatures.pdf'],
];
const bytes = s => Buffer.byteLength(s);
function clip(s, max) { let b = Buffer.from(s).subarray(0, Math.max(0, max)); return b.toString('utf8').replace(/\uFFFD+$/u, ''); }
function positions(count, total) { return [...new Set(Array.from({length: Math.min(count,total)},(_,i)=>Math.round(i*(total-1)/Math.max(1,Math.min(count,total)-1))))]; }
function pageSample(pages, count, budget) {
  const ids = positions(count, pages.length);
  const header = `Sampled ${ids.length} of ${pages.length} pages. Page numbers are PDF positions, not printed labels. Omitted pages and clipped text are unknown; do not infer their contents.\n`;
  const labels = ids.map(i=>`\n[Page ${i+1}/${pages.length}; source ${bytes(pages[i])} bytes; excerpt may be clipped]\n`);
  let remaining = budget-bytes(header)-labels.reduce((n,s)=>n+bytes(s),0);
  // Allocate fairly, redistributing unused allowance from short pages.
  const allocation = ids.map(()=>0);
  while(remaining>0) {
    const eligible=ids.map((id,i)=>({id,i})).filter(({id,i})=>allocation[i]<bytes(pages[id]));
    if(!eligible.length) break;
    const share=Math.max(1,Math.floor(remaining/eligible.length));
    for(const {id,i} of eligible) { const take=Math.min(remaining,share,bytes(pages[id])-allocation[i]); allocation[i]+=take; remaining-=take; }
  }
  const excerpts=ids.map((id,i)=>clip(pages[id],allocation[i]));
  return {text:header+ids.map((id,i)=>labels[i]+excerpts[i]).join(''),pageIds:ids.map(i=>i+1), selectedSourceBytes:excerpts.reduce((n,s)=>n+bytes(s),0), clippedPages:ids.filter((id,i)=>bytes(excerpts[i])<bytes(pages[id])).length};
}
function baseline(text) {
  const b=Buffer.from(text); let input=text, readBytes=b.length;
  if(b.length>262144) { input=Array.from({length:16},(_,i)=>{const start=Math.floor(i*(b.length-16384)/15);return `[Source bytes ${start}-${start+16383} of ${b.length}]\n${b.subarray(start,start+16384).toString('utf8').replace(/^\uFFFD+|\uFFFD+$/g,'')}`;}).join('\n\n'); readBytes=262144; }
  return {text:selectSummaryInput(input,b.length>262144).text,selectedSourceBytes:readBytes};
}
const samples=[], documents=[];
for(const [id,file] of files) {
  const raw=execFileSync('pdftotext',['-layout',file,'-'],{maxBuffer:100*1024*1024,encoding:'utf8'});
  const pages=raw.split('\f');if(!pages.at(-1)?.trim())pages.pop();
  const sorted=pages.map(bytes).sort((a,b)=>a-b);
  documents.push({id,file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex'),pages:pages.length,extractedBytes:bytes(raw),pageBytes:{min:sorted[0],median:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)}});
  const candidates=[['baseline',baseline(raw)],...[[10,10000],[20,10000],[10,20000],[20,20000]].map(([n,b])=>[`pages${n}-bytes${b}`,pageSample(pages,n,b)])];
  for(const [candidate,s] of candidates) samples.push({document:id,candidate,...s,inputBytes:bytes(s.text),inputCharacters:s.text.length});
}
writeFileSync(`${out}/samples.json`,JSON.stringify(samples,null,2));
const results={createdAt:new Date().toISOString(),scope:'offline replay after full pdftotext extraction; selectedSourceBytes models bounded payload reads, not measured production IO; no quality or latency conclusions',documents,measurements:samples.map(({text,...m})=>m)};
writeFileSync(`${out}/measurements.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
