"""Reconcile frozen evaluation and fresh timing evidence without selecting policies."""
import argparse,json,random,statistics
from collections import defaultdict
from pathlib import Path
from contract import file_hash,immutable_json

def timing_summary(root,policy_hash):
    complete=json.loads((root/'complete.json').read_text())
    schedule=json.loads((root/'schedule.json').read_text())
    if complete['scheduleHash']!=file_hash(root/'schedule.json') or schedule['policyHash']!=policy_hash:
        raise RuntimeError('timing-receipt-mismatch')
    if complete['samples']!=len(schedule['schedule']):raise RuntimeError('incomplete-timing')
    if set(complete.get('resultHashes',{}))!={f'{i:03d}.json' for i in range(len(schedule['schedule']))}:raise RuntimeError('timing-hash-membership-mismatch')
    pairs=defaultdict(dict)
    for i,expected in enumerate(schedule['schedule']):
        if file_hash(root/f'{i:03d}.json')!=complete['resultHashes'][f'{i:03d}.json']:raise RuntimeError('changed-timing-sample')
        result=json.loads((root/f'{i:03d}.json').read_text())
        if any(result[k]!=v for k,v in expected.items()) or result['policyHash']!=policy_hash:raise RuntimeError('timing-sample-mismatch')
        key=(result['case'],result['repeat'])
        if result['arm'] in pairs[key]:raise RuntimeError('duplicate-timing-arm')
        pairs[key][result['arm']]=result
    if any(set(pair)!=set(['selected','strong']) for pair in pairs.values()):raise RuntimeError('unpaired-timing')
    selected=sum(pair['selected']['elapsedSeconds'] for pair in pairs.values())
    strong=sum(pair['strong']['elapsedSeconds'] for pair in pairs.values())
    pages=sum(pair['selected']['pages'] for pair in pairs.values())
    families=defaultdict(list)
    for (case,repeat),pair in pairs.items():families[case].append(pair)
    rng=random.Random(92017);draws=[]
    for _ in range(2000):
        rows=[pair for case in rng.choices(list(families),k=len(families)) for pair in families[case]]
        draws.append(1-sum(p['selected']['elapsedSeconds'] for p in rows)/sum(p['strong']['elapsedSeconds'] for p in rows))
    return {'scope':'fresh local serial document extraction; excludes embeddings/storage/queue/network',
            'pairs':len(pairs),'distinctDocuments':len(families),'repeatedPagesPerArm':pages,
            'selectedSeconds':selected,'strongSeconds':strong,'elapsedSaving':1-selected/strong,
            'elapsedSaving95CI':[sorted(draws)[49],sorted(draws)[1949]],
            'selectedPagesPerMinute':pages*60/selected,'selectedMinutesPer100Pages':selected/pages*100/60,
            'selectedCpuSeconds':sum(p['selected']['cpuSeconds'] for p in pairs.values()),
            'strongCpuSeconds':sum(p['strong']['cpuSeconds'] for p in pairs.values()),
            'medianPairedSpeedup':statistics.median(p['strong']['elapsedSeconds']/p['selected']['elapsedSeconds'] for p in pairs.values()),
            'uncertainty':'paired source-document bootstrap, three repeats retained within document; six-document timing panel'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--selection',type=Path,required=True);p.add_argument('--timing',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    heldout=json.loads((a.selection/'heldout-report.json').read_text())
    timing=timing_summary(a.timing,file_hash(a.selection/'frozen-policy.json'))
    absolute_quality=heldout['result']['quality']>=.95 and heldout['result']['passRate']>=.90
    accepted=absolute_quality and heldout['constraintsPass'] and heldout['qualityNoninferioritySupported'] and timing['elapsedSaving95CI'][0]>0
    result={'acceptedLocalImprovement':accepted,'absoluteQualityPass':absolute_quality,'absoluteQualityFloors':{'meanQuality':.95,'pagePassRate':.90},'heldout':heldout,'freshTiming':timing,
            'monetarySavings':None,'costLimitation':'No hosted API spend or priced compute rental measured; CPU work is not a dollar bill.',
            'optimalityLimitation':'Best eligible policy among a finite training shortlist confirmed once on family-held-out synthetic documents; no global or production optimality claim.'}
    a.out.mkdir(parents=True,exist_ok=True);immutable_json(a.out/'reconciled.json',result)
    print(json.dumps({'acceptedLocalImprovement':accepted,'freshTiming':timing,'heldoutQuality':heldout['result']['quality'],'heldoutPassRate':heldout['result']['passRate']}))
