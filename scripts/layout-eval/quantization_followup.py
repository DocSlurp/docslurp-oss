#!/usr/bin/env python3
"""Bounded response to a measured U8S8 failure; preserves the original arm."""
import argparse
import hashlib
import shutil
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--hourly-usd',type=float,required=True)
    parser.add_argument('--max-seconds',type=int,default=240)
    args=parser.parse_args()
    if not 0<=args.hourly_usd<5 or not 1<=args.max_seconds<=600: raise ValueError('Invalid bounded followup price/time')
    root=args.root.resolve(); out=args.output_dir.resolve()
    if out.exists(): raise ValueError('Refuse existing followup directory')
    out.mkdir(parents=True); scripts=root/'scripts/layout-eval'
    arms=[{'name':'s8s8','activation':'int8','weight':'int8','reduce_range':False},
          {'name':'u8s8-reduced','activation':'uint8','weight':'int8','reduce_range':True},
          {'name':'u8u8','activation':'uint8','weight':'uint8','reduce_range':False}]
    plan={'created_unix':time.time(),'trigger':'Initial U8S8 per-channel catastrophic quality loss and slower execution',
          'hypothesis':'x86 AVX2 U8S8 saturation; not established until measured',
          'primary_source':'https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html',
          'per_arm_source':{arm['name']:'https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html#data-type-selection' for arm in arms},
          'source_code_sha256':{name:hashlib.sha256((scripts/name).read_bytes()).hexdigest() for name in ('quantize_small.py','benchmark.py','adapters.py','scoring.py')},
          'manifest_sha256':hashlib.sha256((root/'dataset/manifest.jsonl').read_bytes()).hexdigest(),
          'screen_sha256':hashlib.sha256((root/'dataset/screen-dev.jsonl').read_bytes()).hexdigest(),
          'source_graph_sha256':hashlib.sha256((root/'models/pp-small.onnx').read_bytes()).hexdigest(),
          'arms':arms,'calibration':'same32 train pixel-only images seed417','evaluation':'same160 development images, original payload,threads4',
          'max_seconds':args.max_seconds,'hourly_usd':args.hourly_usd,'promotion':'requires strict and localization gates; no holdout use'}
    snapshot=out/'source-snapshot'; snapshot.mkdir()
    for name in ('quantize_small.py','benchmark.py','adapters.py','scoring.py'): shutil.copy2(scripts/name,snapshot/name)
    (out/'plan.json').write_text(json.dumps(plan,indent=2)+'\n'); deadline=time.monotonic()+args.max_seconds
    for arm in arms:
        graph=out/(arm['name']+'.onnx')
        quant=[sys.executable,str(scripts/'quantize_small.py'),'--model',str(root/'models/pp-small.onnx'),'--output',str(graph),
               '--manifest',str(root/'dataset/manifest.jsonl'),'--split','train','--limit','32',
               '--activation-type',arm['activation'],'--weight-type',arm['weight']]
        if arm['reduce_range']: quant+=['--reduce-range']
        bench=[sys.executable,str(scripts/'benchmark.py'),'--model','pp-small-onnx','--device','cpu','--onnx-path',str(graph),
               '--threads','4','--manifest',str(root/'dataset/screen-dev.jsonl'),'--split','dev','--repeats','1','--warmup','3',
               '--threshold','.3','--seed','417','--revision','8ac289e66575bb9bba6e15c53719d8b15cc9b3b2',
               '--hourly-usd',str(args.hourly_usd),'--output',str(out/(arm['name']+'.jsonl'))]
        for stage,command in [('quantize',quant),('benchmark',bench)]:
            remaining=deadline-time.monotonic()
            if remaining<=0: raise TimeoutError('Followup bound reached')
            stamp=time.time()
            with (out/(arm['name']+'-'+stage+'.log')).open('x') as log:
                result=subprocess.run(command,cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=remaining,env=os.environ)
            event={'arm':arm['name'],'stage':stage,'command':command,'exit_code':result.returncode,'elapsed_seconds':time.time()-stamp}
            with (out/'events.jsonl').open('a') as stream: stream.write(json.dumps(event)+'\n')
            print(json.dumps(event),flush=True)
            if result.returncode: break
    (out/'complete.json').write_text(json.dumps({'completed_unix':time.time()})+'\n')


if __name__=='__main__': main()
