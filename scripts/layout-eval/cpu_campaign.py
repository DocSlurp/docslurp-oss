#!/usr/bin/env python3
"""Bounded serial CPU campaign; all adaptive selection uses development outputs only.

No host creation, pricing lookup, remote API, heldout reads, or model downloads.
Run inside the preinstalled Paddle+CPU-ORT environment on the authorized host.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

REVISION='8ac289e66575bb9bba6e15c53719d8b15cc9b3b2'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--output-dir',required=True,type=Path)
    parser.add_argument('--hourly-usd',required=True,type=float)
    parser.add_argument('--max-seconds',type=int,default=1800)
    args=parser.parse_args()
    if not 0<=args.hourly_usd<5 or not 1<=args.max_seconds<=18000: raise ValueError('Outside authorized rate or runtime bounds')
    root=args.root.resolve(); out=args.output_dir.resolve()
    if out.exists(): raise ValueError('Refuse to reuse existing CPU campaign evidence directory')
    out.mkdir(parents=True)
    scripts=root/'scripts/layout-eval'; manifest=root/'dataset/manifest.jsonl'; screen=root/'dataset/screen-dev.jsonl'
    graph=root/'models/pp-small.onnx'; quantized=out/'pp-small-int8.onnx'
    if quantized.exists(): raise ValueError('INT8 graph already exists: select a fresh campaign graph path to retain provenance')
    started=time.time(); deadline=time.monotonic()+args.max_seconds
    records=[]
    def save_event(record):
        records.append(record)
        with (out/'events.jsonl').open('a') as stream: stream.write(json.dumps(record)+'\n')
        print(json.dumps(record),flush=True)
    def execute(name,command):
        remaining=deadline-time.monotonic()
        if remaining<1: raise TimeoutError('CPU campaign exceeded declared wall-time bound')
        stamp=time.time()
        with (out/(name+'.log')).open('x') as log:
            try:
                result=subprocess.run(command,cwd=root,stdout=log,stderr=subprocess.STDOUT,
                    timeout=remaining,env=dict(os.environ,PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK='True'))
                code=result.returncode
            except subprocess.TimeoutExpired:
                save_event({'job':name,'command':command,'exit_code':'timeout','elapsed_seconds':time.time()-stamp})
                raise
        save_event({'job':name,'command':command,'exit_code':code,'elapsed_seconds':time.time()-stamp})
        return code
    variants=[]; seen=set()
    for filename in ('variants-screen.json','variants-byte-extreme.json'):
        for item in json.loads((scripts/filename).read_text()):
            if item['name'] not in seen: variants.append(item); seen.add(item['name'])
    variants_path=out/'byte-variants.json'; variants_path.write_text(json.dumps(variants,indent=2)+'\n')
    jobs=[]
    for runtime in ('ort-fp32','native-fp32','ort-int8'):
        for threads in (1,2,4,8): jobs.append({'name':f'{runtime}-t{threads}','runtime':runtime,'threads':threads})
    plan={'schema_version':'layout-cpu-campaign-v1','created_unix':started,'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),
          'screen_sha256':hashlib.sha256(screen.read_bytes()).hexdigest(),'max_seconds':args.max_seconds,'hourly_usd':args.hourly_usd,
          'calibration':{'split':'train','limit':32,'seed':417,'pixel_only':True},'baseline_jobs':jobs,
          'later_arms':['best eligible runtime on original payload plus orientation','best eligible runtime on declared byte variants'],
          'selection_policy':{'reference':'ort-fp32-t1','require_zero_failures':True,'max_macro_iou50_drop':.02,
                              'max_family_macro_iou50_drop':.05,'minimize':'consumer_path_ms mean',
                              'maturity':'relative efficiency choice only; does not waive absolute quality gates'},
          'variants':variants,'provenance':'No labels are passed to models or calibration; dev references used only for selection after inference.'}
    (out/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
    execute('quantize-train32',[sys.executable,str(scripts/'quantize_small.py'),'--model',str(graph),'--output',str(quantized),
                              '--manifest',str(manifest),'--split','train','--limit','32'])
    def benchmark_command(job,output,extra=()):
        model='pp-small' if job['runtime']=='native-fp32' else 'pp-small-onnx'
        command=[sys.executable,str(scripts/'benchmark.py'),'--model',model,'--device','cpu','--threads',str(job['threads']),
            '--manifest',str(screen),'--split','dev','--repeats','1','--warmup','3','--batch-size','1',
            '--threshold','.3','--seed','417','--hourly-usd',str(args.hourly_usd),'--revision',REVISION,'--output',str(output)]
        if model=='pp-small': command+=['--model-path',str(root/'models/pp-small')]
        else: command+=['--onnx-path',str(quantized if job['runtime']=='ort-int8' else graph)]
        return command+list(extra)
    summaries={}
    for job in jobs:
        output=out/(job['name']+'.jsonl')
        execute(job['name'],benchmark_command(job,output))
        summary=output.with_suffix('.summary.json')
        if summary.exists(): summaries[job['name']]=json.loads(summary.read_text())['summaries']['original']
    reference=summaries.get('ort-fp32-t1')
    if not reference or reference['failures']: raise RuntimeError('Reference CPU run unavailable; inspect retained errors')
    def eligible(summary):
        if summary['failures']: return False
        score=summary['scores']['iou50']['macro_f1_truth_present']; baseline=reference['scores']['iou50']['macro_f1_truth_present']
        if score is None or baseline is None or score<baseline-.02: return False
        for family,ref in reference['per_family'].items():
            base=ref['iou50']['macro_f1_truth_present']; actual=summary['per_family'][family]['iou50']['macro_f1_truth_present']
            if base is not None and (actual is None or actual<base-.05): return False
        return True
    candidates=[job for job in jobs if job['name'] in summaries and eligible(summaries[job['name']])]
    if not candidates: raise RuntimeError('No runtime satisfies the declared relative quality policy')
    winner=min(candidates,key=lambda job:summaries[job['name']]['successful_latency_ms']['consumer_path_ms']['mean'])
    selection={'selected':winner,'eligible_candidates':[j['name'] for j in candidates],
               'summary':summaries[winner['name']],'scope':'development runtime selection; not production promotion'}
    (out/'runtime-selection.json').write_text(json.dumps(selection,indent=2)+'\n')
    execute('best-runtime-orientation',benchmark_command(winner,out/'best-runtime-orientation.jsonl',[
        '--orientation-onnx-path',str(root/'models/orientation/inference.onnx'),
        '--orientation-revision','7330ab7039123e46af2dc03154b9969aa412c61d']))
    execute('best-runtime-byte-frontier',benchmark_command(winner,out/'best-runtime-byte-frontier.jsonl',['--variants',str(variants_path)]))
    final={'elapsed_seconds':time.time()-started,'estimated_allocated_host_usd':(time.time()-started)/3600*args.hourly_usd,
           'jobs_completed':len(records),'selected_runtime':winner,'declared_timeout_seconds':args.max_seconds}
    (out/'complete.json').write_text(json.dumps(final,indent=2)+'\n'); print(json.dumps(final))


if __name__=='__main__': main()
