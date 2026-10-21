#!/usr/bin/env python3
"""Paired source-cluster bootstrap of fixed layout predictions, without model calls.

A cluster is an authored source page, including every capture and repeat. Paired
resampling preserves baseline/candidate identity and avoids pretending transformed
siblings are independent. Confidence intervals describe this synthetic corpus only.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import random
from scoring import match_boxes,metrics


def counts_for(row,threshold=.5):
    truth,predicted=row['truth'],row['regions']; counts=defaultdict(lambda:[0,0,0])
    matched=match_boxes(truth,predicted,threshold)
    ti,pi={p[0] for p in matched},{p[1] for p in matched}
    for i,j,_ in matched: counts[truth[i]['label']][0]+=1
    for i,t in enumerate(truth):
        if i not in ti: counts[t['label']][2]+=1
    for i,p in enumerate(predicted):
        if i not in pi: counts[p['label']][1]+=1
    return dict(counts)


def add_counts(items):
    out=defaultdict(lambda:[0,0,0])
    for counts in items:
        for label,values in counts.items():
            for index,value in enumerate(values): out[label][index]+=value
    return dict(out)


def count_metrics(counts):
    present=[label for label,v in counts.items() if v[0]+v[2]>0]
    totals=[sum(values[index] for values in counts.values()) for index in range(3)]
    return {'micro_f1':metrics(*totals)['f1'],
            'macro_f1_truth_present':sum(metrics(*counts[label])['f1'] or 0. for label in present)/len(present) if present else None,
            'per_class':{label:metrics(*values) for label,values in sorted(counts.items())}}


def index_rows(path,variant):
    rows={}
    for line in Path(path).read_text().splitlines():
        row=json.loads(line)
        if row['variant']!=variant: continue
        key=(row['page_id'],row['repeat'])
        if key in rows: raise ValueError(f'Duplicate paired key {key} in {path}')
        rows[key]=row
    if not rows: raise ValueError(f'No variant {variant} in {path}')
    return rows


def index_blocks(paths,variant):
    output={}
    for block,path in enumerate(paths):
        for key,row in index_rows(path,variant).items(): output[(*key,block)]=row
    return output


def paired_comparison(baseline,candidate,replicates=2000,seed=417,threshold=.5):
    if set(baseline)!=set(candidate):
        raise ValueError(f'Paired keys differ: baseline-only {len(set(baseline)-set(candidate))}; candidate-only {len(set(candidate)-set(baseline))}')
    clusters=defaultdict(lambda:{'baseline':[],'candidate':[],'families':set()})
    for key in sorted(baseline):
        left,right=baseline[key],candidate[key]
        if left['truth']!=right['truth']: raise ValueError(f'Paired references differ for {key}')
        source=left.get('metadata',{}).get('source_id')
        if not source: raise ValueError(f'Missing source_id cluster for {key}; image IDs are not independent authored sources')
        if right.get('metadata',{}).get('source_id')!=source: raise ValueError('Source identity changed across candidates')
        cluster=clusters[source]
        cluster['baseline'].append(counts_for(left,threshold)); cluster['candidate'].append(counts_for(right,threshold))
        family=left.get('source_family') or left.get('metadata',{}).get('source_family')
        cluster['families'].add(family)
    for cluster in clusters.values():
        cluster['baseline']=add_counts(cluster['baseline']); cluster['candidate']=add_counts(cluster['candidate'])
    def assess(sources):
        l=count_metrics(add_counts(clusters[s]['baseline'] for s in sources))
        r=count_metrics(add_counts(clusters[s]['candidate'] for s in sources))
        delta={key:r[key]-l[key] if r[key] is not None and l[key] is not None else None for key in ('micro_f1','macro_f1_truth_present')}
        return l,r,delta
    sources=sorted(clusters); left,right,delta=assess(sources)
    randomizer=random.Random(seed); distributions=defaultdict(list)
    for _ in range(replicates):
        sampled=randomizer.choices(sources,k=len(sources)); _,_,difference=assess(sampled)
        for key,value in difference.items():
            if value is not None: distributions[key].append(value)
    def interval(values):
        values=sorted(values)
        return {'low':values[int(.025*(len(values)-1))],'high':values[int(.975*(len(values)-1))]} if values else None
    per_family={}
    families=sorted(set(f for c in clusters.values() for f in c['families'] if f))
    for family in families:
        selected=[source for source in sources if family in clusters[source]['families']]
        l,r,d=assess(selected)
        per_family[family]={'sources':len(selected),'baseline':l,'candidate':r,'candidate_minus_baseline':d}
    return {'schema_version':'layout-paired-cluster-comparison-v1','matching_iou':threshold,
            'cluster_unit':'metadata.source_id; captures and repeats remain grouped','sources':len(sources),
            'paired_image_repeats':len(baseline),'replicates':replicates,'seed':seed,
            'baseline':left,'candidate':right,'candidate_minus_baseline':delta,
            'delta_confidence95_percentile':{key:interval(value) for key,value in distributions.items()},
            'per_family':per_family,'limitations':['Synthetic silver only; no real-world transfer claim.',
                'Confidence intervals condition on this generated corpus; small family cluster counts are weak evidence.',
                'Selection on development data invalidates interpreting its CI as independent confirmation.']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',type=Path,nargs='+',required=True); parser.add_argument('--baseline-variant',default='original')
    parser.add_argument('--candidate',type=Path,nargs='+',required=True); parser.add_argument('--candidate-variant',required=True)
    parser.add_argument('--output',type=Path,required=True); parser.add_argument('--replicates',type=int,default=2000)
    parser.add_argument('--seed',type=int,default=417); parser.add_argument('--iou',type=float,default=.5)
    args=parser.parse_args()
    if args.output.exists(): raise ValueError('Refuse to overwrite paired comparison evidence')
    if args.replicates<1 or not 0<args.iou<=1: raise ValueError('Invalid bootstrap count or IoU')
    if len(args.baseline)!=len(args.candidate): raise ValueError('Baseline and candidate confirmation block counts must agree')
    output=paired_comparison(index_blocks(args.baseline,args.baseline_variant),index_blocks(args.candidate,args.candidate_variant),args.replicates,args.seed,args.iou)
    output.update(baseline_paths=[str(p) for p in args.baseline],baseline_variant=args.baseline_variant,
                  candidate_paths=[str(p) for p in args.candidate],candidate_variant=args.candidate_variant,confirmation_blocks=len(args.baseline))
    args.output.write_text(json.dumps(output,indent=2)+'\n'); print(json.dumps(output['candidate_minus_baseline']))


if __name__=='__main__': main()
