// Opt-in paid comparison. Run with OPENROUTER_API_KEY and --budget-usd <= approved budget.
// Outputs stay in ignored .cache; never bills a customer workspace.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { generateOpenRouterText } from '../../worker/src/lib/ai.ts';
import { PipelineUsageEventLedger } from '../../worker/src/pipeline/usage-ledger.ts';
import { resolvePipelineTextModel } from '../../packages/shared/src/pipeline.ts';
import { buildTrustedDocumentTaskPrompt } from '../../worker/src/lib/trusted-llm-task.ts';
const budget=Number(process.argv[process.argv.indexOf('--budget-usd')+1]);
if(!Number.isFinite(budget)||budget<=0||budget>6) throw Error('Explicit budget in (0, 6] required');
if(!process.env.OPENROUTER_API_KEY) throw Error('OPENROUTER_API_KEY is required');
const model=resolvePipelineTextModel({},'document-summary',process.env.DOCSLURP_TEXT_MODEL);
const catalog=await fetch('https://openrouter.ai/api/v1/models').then(r=>{if(!r.ok)throw Error('Model price lookup failed');return r.json()});
const entry=catalog.data.find(m=>m.id===model);
const inputPrice=Number(entry?.pricing?.prompt), outputPrice=Number(entry?.pricing?.completion);
if(!entry||!Number.isFinite(inputPrice)||!Number.isFinite(outputPrice))throw Error('Current model prices unavailable');
const directory='.cache/summary-eval';
const run=process.env.SUMMARY_EVAL_RUN ?? 'hosted';
if(!/^[a-z0-9-]+$/.test(run))throw Error('Invalid run name');
const noReasoning=process.env.SUMMARY_EVAL_NO_REASONING === '1';
const maxCalls=Number(process.env.SUMMARY_EVAL_MAX_CALLS ?? 150);
let completed=0;
const resultsFile=`${directory}/${run}.jsonl`, usageFile=`${directory}/${run}-usage.jsonl`;
// Refuse to overwrite or accidentally repeat a paid run.
if(existsSync(resultsFile))throw Error('Existing paid results found; review before starting another run');
const samples=JSON.parse(readFileSync(`${directory}/${process.env.SUMMARY_EVAL_INPUT ?? 'samples.json'}`,'utf8'));
const ledger=new PipelineUsageEventLedger();
let reservedTotal=0;
for(let repeat=0;repeat<2;repeat++) for(const sample of samples) for(const cap of (process.env.SUMMARY_EVAL_CAP ? [Number(process.env.SUMMARY_EVAL_CAP)] : [256,384,512])) {
  if(completed>=maxCalls)break;
  const task=buildTrustedDocumentTaskPrompt({instruction:'Generate a one-paragraph summary of this document for use in a search index.',outputContract:'Return only the summary paragraph. Be concise and capture the main topics, entities, and purpose. The input may contain excerpts. Do not claim exhaustive coverage or infer facts from omitted sections.',untrustedContent:sample.text,untrustedContentLabel:'document text'});
  // Conservative exposure bound: one token per UTF-8 byte, 2 KiB overhead,
  // 3 attempts (SDK default two retries), and 2x pricing margin. Count failed
  // calls at their full reservation. No retry loop in this harness.
  const reserve=6*((Buffer.byteLength(task.system+task.prompt)+2048)*inputPrice+cap*outputPrice);
  if(reservedTotal+reserve>budget) { console.log(JSON.stringify({stopped:'budget',reservedTotal,budget})); process.exit(0); }
  reservedTotal+=reserve;
  const scope={scope:'summary-eval',run,noReasoning,document:sample.document,candidate:sample.candidate,repeat,cap};
  const started=performance.now();
  try {
    const result=await generateOpenRouterText({operation:'document-summary',apiKey:process.env.OPENROUTER_API_KEY,model,privacyMode:'standard',...task,maxOutputTokens:cap,textGeneration:{model:null,models:{},...(noReasoning ? {reasoningEffort:'none'} : {}),maxOutputTokens:{'document-summary':cap}},signal:AbortSignal.timeout(120000)});
    ledger.record({provider:'openrouter',model,metric:'summary-eval',amount:1,unit:'generation',inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,costCents:result.usage.costCents,metadata:{...result.usage.metadata,...scope}});
    completed++;
    const batch=ledger.checkpoint(); for(const event of batch.events)appendFileSync(usageFile,JSON.stringify(event)+'\n');batch.commit();
    appendFileSync(resultsFile,JSON.stringify({...scope,model,elapsedMs:performance.now()-started,reserveUsd:reserve,priceSnapshot:entry.pricing,...result})+'\n');
  } catch(error) {
    appendFileSync(resultsFile,JSON.stringify({...scope,model,elapsedMs:performance.now()-started,reserveUsd:reserve,error:String(error),charge:'unknown; full reservation retained'})+'\n');
    // Stop on errors rather than repeatedly spending while accounting is uncertain.
    throw error;
  }
}
console.log(JSON.stringify({finished:true,reservedTotal,ledger:ledger.totals()}));
