// Follow-up hypothesis prompted by the pilot: retain opening identity/contents pages.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const samples=[];
for(const year of ['2023','2024']){
 const pages=readFileSync(`.cache/summary-eval/catalog-${year}.txt`,'utf8').split('\f');if(!pages.at(-1)?.trim())pages.pop();
 for(const count of [10,20])for(const seed of [1,2]){
  const ids=[0,1,2,pages.length-1];const slots=count-4;
  for(let i=0;i<slots;i++) {const lo=3+Math.floor(i*(pages.length-4)/slots),hi=3+Math.floor((i+1)*(pages.length-4)/slots);const h=createHash('sha256').update(`${year}:${seed}:${i}`).digest().readUInt32BE();ids.push(lo+h%Math.max(1,hi-lo));}ids.sort((a,b)=>a-b);
  const header=`Evidence from ${count} of ${pages.length} PDF pages. Opening three pages plus seeded stratified samples and final page. Most pages are omitted. Describe only supported purpose/topics; do not infer omitted contents. State that the overview is sampled.\n`;
  const labels=ids.map(id=>`\n[PDF page ${id+1}/${pages.length}; clipped excerpt]\n`);
  // Collapse layout padding for evidence only; original source remains intact.
  const texts=ids.map(id=>pages[id].replace(/[\t ]+/g,' ').replace(/\n{3,}/g,'\n\n').trim());
  let remaining=10000-Buffer.byteLength(header+labels.join(''));const allocations=ids.map(()=>0);
  while(remaining>0){const eligible=texts.map((text,i)=>({text,i})).filter(({text,i})=>allocations[i]<Buffer.byteLength(text));if(!eligible.length)break;const share=Math.max(1,Math.floor(remaining/eligible.length));for(const {text,i}of eligible){const n=Math.min(remaining,share,Buffer.byteLength(text)-allocations[i]);allocations[i]+=n;remaining-=n;}}
  const text=header+texts.map((t,i)=>labels[i]+Buffer.from(t).subarray(0,allocations[i]).toString('utf8').replace(/\uFFFD+$/,'')).join('');
  samples.push({document:`catalog-${year}`,candidate:`front3-stratified${count}-seed${seed}-bytes10000`,text,pageIds:ids.map(i=>i+1),inputBytes:Buffer.byteLength(text),sourceReadBytes:'not measured; normalized extracted text prototype'});
 }
}
writeFileSync('.cache/summary-eval/refined-samples.json',JSON.stringify(samples,null,2));console.log(`Prepared ${samples.length} follow-up inputs`);
