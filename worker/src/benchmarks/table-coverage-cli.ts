import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { coverage, htmlCells, type Cell, type Coverage } from './table-coverage.js';

// Offline only: accepts retained provider responses; never submits jobs or loads credentials.
const file = process.argv[2], output = process.argv[3];
if (!file || !output) throw new Error('Usage: tsx table-coverage-cli.ts manifest.json report.json');
interface Case { id: string; category: string; gold: string; outputs: Record<string,string> }
const manifest = JSON.parse(await readFile(file,'utf8')) as { providers: string[]; candidate: string; requiredCategories: string[]; cases: Case[] };
if (!manifest.providers.includes(manifest.candidate) || manifest.providers.length < 2 || !manifest.requiredCategories.length || !manifest.cases.length) throw new Error('Comparison requires candidate, competitors, categories and cases');
const root=dirname(resolve(file));
type Row = { case: string; category: string; provider: string } & ({error: null} & Coverage | {error: string});
const rows: Row[]=[];
if (new Set(manifest.cases.map(c=>c.id)).size !== manifest.cases.length || new Set(manifest.providers).size !== manifest.providers.length) throw new Error("Duplicate case or provider identity");
for (const c of manifest.cases) {
 const gold=JSON.parse(await readFile(resolve(root,c.gold),'utf8')) as Cell[];
 for (const provider of manifest.providers) {
  try {
   if (!c.outputs[provider]) throw new Error('Missing provider output');
   const actual=htmlCells(await readFile(resolve(root,c.outputs[provider]!),'utf8'));
   rows.push({case:c.id,category:c.category,provider,...coverage(gold,actual),error:null});
  } catch(error) { rows.push({case:c.id,category:c.category,provider,error:String(error)}); }
 }
}
const required = ["simple","colspan","rowspan","multi-header","multipage","scan","rotated","borderless","financial"];
const gates=[...new Set([...required,...manifest.requiredCategories])].map(category=>{
 const cases=manifest.cases.filter(c=>c.category===category);
 const pass=cases.length>=2 && cases.every(c=>{
  const all=rows.filter(r=>r.case===c.id); const candidate=all.find(r=>r.provider===manifest.candidate);
  return candidate && !candidate.error && 'valueRecall' in candidate && candidate.valueRecall >= 0.99 && candidate.topologyRecall >= 0.99 && candidate.precision >= 0.99 && all.every(other=>!other.error && 'valueRecall' in other && candidate.valueRecall!>=other.valueRecall! && candidate.topologyRecall!>=other.topologyRecall! && candidate.precision!>=other.precision!);
 });
 return {category,cases:cases.length,pass};
});
const report={passed:gates.every(g=>g.pass),gates,rows,note:'Missing data fails the gate. No latency/cost or production-deployment inference. Run evaluation-integrity-judge separately before promotion.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,gates}));
if(!report.passed) process.exitCode=1;
