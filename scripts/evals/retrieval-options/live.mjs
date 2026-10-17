import fs from 'node:fs';
import {sql} from '/tmp/docslurp-embedding-20261017/common.mjs';
import {loadQueries,judge} from '/tmp/docslurp-large-docs/harness/bench.mjs';
const broad=process.argv.includes('--broad');
const dest='/tmp/docslurp-retrieval-options-20261017'+(broad?'/broad':''),base='/tmp/docslurp-embedding-20261017';
fs.mkdirSync(dest,{recursive:true});
const reportPath=`${dest}/live.json`;if(fs.existsSync(reportPath))throw Error('Refusing to overwrite prior paid run');
const queries=loadQueries(`${base}/queries.json`);
const cases=[];
for(const [label,n] of (broad?[['courses',99],['academic',99],['statutes83',99],['statutes109',99],['statutes85',99]]:[['courses',3],['academic',1],['statutes83',1],['statutes109',1]])){
 const state=JSON.parse(fs.readFileSync(`${base}/runs/native-stress-${label}/state.json`));
 const cookies=JSON.parse(fs.readFileSync(`${base}/runs/native-stress-${label}/.cookies.json`));
 for(const q of queries.filter(x=>x.document===state.fileId).slice(0,n))cases.push({q,state,cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ')});
}
const defaults={limit:'10',rerank:'true',mmr:'false',mmrLambda:'.4',parentRetrieval:'true',hyde:'false',summarySeed:'false',compression:'false',queryRewrite:'false',queryDecompose:'false',stepback:'false',selfQuery:'false',iterativeMultiHop:'false',graphExpansion:'false',communityExpansion:'false',minScore:'0'};
const arms=broad?[['baseline',{}],['queryRewrite',{queryRewrite:'true'}],['stepback',{stepback:'true'}],['stepback_rewrite',{stepback:'true',queryRewrite:'true'}]]:[['baseline',{}],['rerank_off',{rerank:'false'}],['parent_off',{parentRetrieval:'false'}],['mmr_025',{mmr:'true',mmrLambda:'.25'}],['mmr_075',{mmr:'true',mmrLambda:'.75'}],['mmr_1',{mmr:'true',mmrLambda:'1'}],...['hyde','queryRewrite','queryDecompose','stepback','summarySeed','selfQuery','compression','iterativeMultiHop','graphExpansion','communityExpansion'].map(x=>[x,{[x]:'true'}])];
const start=new Date();const workspaceIds=[...new Set(cases.map(x=>x.state.workspaceId))];
const report={startedAt:start.toISOString(),deadline:new Date(Date.now()+15*60e3).toISOString(),maxCalls:broad?112:100,capUsd:broad?10:8,reservedUsd:0,scope:'Development queries; live pre-fix production service; all labels previously exposed; no generated answers',results:[],usage:[],status:'running'};
const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
async function usage(){report.usage=await sql`select provider,model,metric,count(distinct id)::int as events,coalesce(sum(input_tokens),0)::float as input_tokens,coalesce(sum(output_tokens),0)::float as output_tokens,coalesce(sum(cost_cents),0)::float as cost_cents from usage_attribution where workspace_id in ${sql(workspaceIds)} and created_at >= ${start} group by provider,model,metric`;report.attributedUsd=report.usage.reduce((a,x)=>a+Number(x.cost_cents)/100,0);save();if(report.attributedUsd>7.5)throw Error('Ledger stop threshold');}
try{
 for(const [arm,flags] of arms){
  for(let i=0;i<cases.length;i+=2){
   await usage();
   if(Date.now()>Date.parse(report.deadline))throw Error('Deadline');
   await Promise.all(cases.slice(i,i+2).map(async c=>{
    const reserve=arm==='compression'?.5:.05;
    if(report.results.length>=report.maxCalls||report.reservedUsd+reserve>7.51)throw Error('Admission cap');
    report.reservedUsd+=reserve;
    const row={arm,query:c.q.id,flags:{...defaults,...flags},startedAt:new Date().toISOString(),status:'admitted'};report.results.push(row);save();
    const url=new URL('https://docslurp.io/v1/search');for(const [k,v]of Object.entries({...row.flags,q:c.q.q,workspaceId:c.state.workspaceId}))url.searchParams.set(k,v);
    const begin=performance.now();
    try{const r=await fetch(url,{headers:{Cookie:c.cookie,Origin:'https://docslurp.io'},signal:AbortSignal.timeout(90000)});row.http=r.status;row.body=await r.json();row.ms=performance.now()-begin;row.status=r.ok?'completed':'http_error';row.judge=r.ok?judge(c.q,(row.body.results??[]).map(x=>({...x,text:[x.text,x.parentText??''].join('\n')})),{documentId:c.state.documentId}):null;}catch(e){row.status='error';row.error=String(e);row.ms=performance.now()-begin;}save();
   }));
  }
  await usage();console.log(JSON.stringify({arm,complete:report.results.filter(x=>x.arm===arm&&x.status==='completed').length,correct:report.results.filter(x=>x.arm===arm&&x.judge?.correct).length,calls:report.results.length,attributedUsd:report.attributedUsd}));
  if(report.results.some(x=>x.status==='error'||x.http>=500))throw Error('Upstream failure stops new admissions');
 }
 report.status='completed';
}catch(e){report.status='stopped';report.reason=String(e);console.log(report.reason);}finally{await usage();report.finishedAt=new Date().toISOString();save();await sql.end();}
