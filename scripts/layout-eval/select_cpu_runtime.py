#!/usr/bin/env python3
"""Review CPU runtime evidence under explicit strict and localization safeguards."""
import argparse
import hashlib
import json
from pathlib import Path


def select_runtime(summaries,jobs):
    reference=summaries['ort-fp32-t1']; baseline=reference['scores']['iou50']
    if reference['failures']: raise ValueError('Reference runtime failed')
    decisions=[]
    for job in jobs:
        summary=summaries.get(job['name']); reasons=[]
        if summary is None:
            decisions.append({'job':job,'eligible':False,'reasons':['missing complete summary']}); continue
        score=summary['scores']['iou50']
        if summary['failures']: reasons.append('nonzero failures')
        if score['macro_f1_truth_present'] is None or score['macro_f1_truth_present']<baseline['macro_f1_truth_present']-.02:
            reasons.append('strict macro IoU50 F1 drop > 2pp')
        for metric in ('f1','recall'):
            actual=score['class_agnostic_localization'][metric]; before=baseline['class_agnostic_localization'][metric]
            if actual is None or (before is not None and actual<before-.02): reasons.append(f'class-agnostic localization {metric} drop > 2pp')
        for family,ref in reference['per_family'].items():
            actual=summary['per_family'][family]['iou50']['macro_f1_truth_present']; before=ref['iou50']['macro_f1_truth_present']
            if before is not None and (actual is None or actual<before-.05): reasons.append(f'{family} strict macro drop > 5pp')
        latency=summary['successful_latency_ms'].get('consumer_path_ms')
        if not latency or latency['mean']<=0: reasons.append('missing positive consumer latency')
        decisions.append({'job':job,'eligible':not reasons,'reasons':reasons,
                          'consumer_mean_ms':latency['mean'] if latency else None,
                          'strict_macro_f1':score['macro_f1_truth_present'],
                          'localization':score['class_agnostic_localization']})
    eligible=[row for row in decisions if row['eligible']]
    winner=min(eligible,key=lambda row:row['consumer_mean_ms'])['job'] if eligible else None
    return {'selected':winner,'decisions':decisions,'reference':'ort-fp32-t1',
            'policy':{'zero_failures':True,'max_strict_macro_iou50_drop':.02,'max_family_macro_iou50_drop':.05,
                      'max_localization_f1_drop':.02,'max_localization_recall_drop':.02},
            'scope':'development efficiency selection only; absolute readiness gates remain separate'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--campaign-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists(): raise ValueError('Refuse to overwrite selection evidence')
    plan=json.loads((args.campaign_dir/'plan.json').read_text()); summaries={}; hashes={}
    for job in plan['baseline_jobs']:
        path=args.campaign_dir/(job['name']+'.summary.json')
        if not path.exists(): raise ValueError(f'Runtime matrix incomplete: {path.name}')
        summaries[job['name']]=json.loads(path.read_text())['summaries']['original']
        hashes[job['name']]=hashlib.sha256(path.read_bytes()).hexdigest()
    result=select_runtime(summaries,plan['baseline_jobs']); result['summary_sha256']=hashes
    amendment=args.campaign_dir/'policy-amendment.json'
    if amendment.exists(): result['policy_amendment']=json.loads(amendment.read_text())
    args.output.write_text(json.dumps(result,indent=2)+'\n'); print(json.dumps(result))
    return 0 if result['selected'] else 2


if __name__=='__main__': raise SystemExit(main())
