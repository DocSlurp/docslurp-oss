import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { mmrSelect } from "../../../server/src/search/mmr.ts";
import { rerankBM25 } from "../../../server/src/search/rerank.ts";
import { reciprocalRankFusion } from "../../../server/src/search/rrf.ts";
import { lostInTheMiddleReorder } from "../../../server/src/search/position-reorder.ts";
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i+1]] : []).filter(x => x.length));
for (const key of ["input", "queries", "judge", "output"]) if (!args[key]) throw Error(`--${key} required`);
const {loadQueries, judge} = await import(pathToFileURL(path.resolve(args.judge)).href);
const queries = loadQueries(args.queries);
const out:any = { scope:"Development-only fixed saved candidate replay; not fresh retrieval or generated-answer evaluation. Original labels exposed. Parent evidence supplied consistently across ranking arms.", createdAt:new Date().toISOString(), sources:[], arms:{}, queries:[] };
const mmrFallback = fs.readFileSync(new URL("../../../server/src/search/mmr.ts", import.meta.url), "utf8").includes("positionDiversity") ? "position_fallback" : "relevance_fallback";
out.mmrFallback=mmrFallback;
const hash = (p:string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
for (const p of [args.queries,args.judge,...["mmr","rerank","rrf","position-reorder"].map(x=>new URL(`../../../server/src/search/${x}.ts`, import.meta.url).pathname)]) out.sources.push({path:p,sha256:hash(p)});
const files = fs.statSync(args.input).isDirectory() ? fs.readdirSync(args.input).filter(x=>/^retrieval-no-rerank-native-stress-.*\.json$/.test(x)).map(x=>path.join(args.input,x)) : [args.input];
for (const file of files) {
 out.sources.push({path:file,sha256:hash(file)});
 const saved=JSON.parse(fs.readFileSync(file,"utf8"));
 const arm=saved.arms.find((x:any)=>x.id===(args.arm??"parent-no-rerank-wide"));
 if(!arm) throw Error(`Missing candidate arm in ${file}`);
 for(const result of arm.results){
  const q=queries.find((q:any)=>q.id===result.query); if(!q) throw Error(`Missing oracle ${result.query}`);
  const rows=result.body.results.map((x:any,i:number)=>({...x,id:String(i)}));
  const expanded=rows.map((x:any)=>({...x,text:[x.text,x.parentText??""].join("\n")}));
  const evidence=new Map(expanded.map((x:any)=>[x.id,x]));
  const ctx={documentId:rows[0]?.citation.documentId};
  const chunk=rerankBM25(q.q,rows), parent=rerankBM25(q.q,expanded);
  const ranks:any={saved_order:rows,bm25_chunk:chunk,bm25_parent:parent,rrf_chunk:reciprocalRankFusion([rows,chunk]),rrf_parent:reciprocalRankFusion([rows,parent])};
  const dedup=(a:any[])=>{const seen=new Set();return a.filter(x=>{const key=x.parentText?.trim()||x.text.trim();if(seen.has(key))return false;seen.add(key);return true;});};
  ranks.bm25_parent_dedup=dedup(parent);
  for(const topK of [5,10,20,50]){
   const variants:any=Object.fromEntries(Object.entries(ranks).map(([name,hits]:any)=>[name,hits.slice(0,topK)]));
   for(const [name,hits] of Object.entries({saved:rows,bm25_parent:parent}) as any){
    for(const lambda of [0,.25,.5,.75,1]) variants[`${name}_${mmrFallback}_lambda_${lambda}`]=mmrSelect(hits.map((x:any)=>({...x,vector:undefined,score:x.crossScore??x.score})),topK,lambda);
   }
   variants.bm25_parent_position_reorder=lostInTheMiddleReorder(parent.slice(0,topK).map((x:any)=>({...x,score:x.crossScore??x.score})));
   for(const [name,hits] of Object.entries(variants) as any){
    const judged=judge(q,hits.map((x:any)=>evidence.get(x.id)),ctx);
    const key=`${name}@${topK}`;
    const z=out.arms[key]??={total:0,correct:0,mrr:0,invalid:0};z.total++;z.correct+=Number(judged.correct);z.mrr+=judged.rank?1/judged.rank:0;z.invalid+=Number(Boolean(judged.invalid));
    out.queries.push({query:q.id,arm:name,topK,rank:judged.rank,correct:judged.correct,ids:hits.map((x:any)=>x.id),candidateCount:rows.length,vectorsPresent:rows.filter((x:any)=>x.vector?.length).length});
   }
  }
 }
}
for(const z of Object.values(out.arms) as any[]) {z.mrr/=z.total;z.recall=z.correct/z.total;}
fs.writeFileSync(args.output,JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify(Object.fromEntries(Object.entries(out.arms).filter(([k])=>k.endsWith("@10"))),null,2));
