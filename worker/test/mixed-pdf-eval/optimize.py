"""Finite, predeclared local policy search. Candidate code never sees reference text.
Heldout is evaluated only with a pre-existing frozen policy; cannot enter search.
"""
import argparse
from collections import defaultdict
import hashlib
import itertools
import json
from pathlib import Path
import random
import statistics
from contract import (file_hash,identity_hash,immutable_json,validate_complete_inventory,validate_policy_receipt,validate_panel_binding,validate_panel_manifest)

PROXY={"mode":"ladder","glyphThreshold":.2,"imageThreshold":.3,"confidenceThreshold":80,"byteThreshold":0,"vectorThreshold":1000000,"byteBasis":"contentDecodedBytes"}

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def mean(items): return statistics.mean(items) if items else 0

def choose(page,policy):
    mode=policy.get("mode")
    if mode in ["native","ocr-fast","ocr-strong"]: return mode, [mode]
    f=page["features"]
    glyphs=f["observedGlyphs"]
    low_yield=glyphs>=500 and f["actualCharacters"] < glyphs*policy["glyphThreshold"]
    image=f["imageCoverage"]>=policy["imageThreshold"]
    vector=f["vectorDrawingCount"]>=policy.get("vectorThreshold",1000000)
    byte_basis=policy.get("byteBasis","contentDecodedBytes")
    byte_ratio=f["actualTextBytes"]/max(1,f[byte_basis])
    residual=byte_ratio<policy.get("byteThreshold",0) and f[byte_basis]>=1000
    needs=low_yield or image or vector or residual or f["invisibleGlyphs"]>0 or f["occludedGlyphs"]>0
    if not needs:return "native",["native"]
    fast=page["candidates"]["ocr-fast"]
    if fast["confidence"] < policy["confidenceThreshold"]:
        return "ocr-strong",["native","ocr-fast","ocr-strong"]
    return "ocr-fast",["native","ocr-fast"]

def summarize(cases,policy):
    all_rows=[];slices=defaultdict(list);families=defaultdict(list);tiers=defaultdict(int)
    for case in cases:
        for page in case["pages"]:
            name,attempts=choose(page,policy);candidate=page["candidates"][name]
            # This is serial-equivalent service work, not measured concurrent pipeline latency.
            seconds=sum(page["candidates"][k]["seconds"]+page["candidates"][k].get("renderSeconds",0) for k in attempts)
            if policy.get("mode")=="ladder":seconds+=page["probeSeconds"]+case["imageListSeconds"]/len(case["pages"])
            if policy.get("byteThreshold",0)>0 and policy.get("byteBasis") in ["singleResidualBytes","fourResidualBytes"]:
                size="1" if policy["byteBasis"]=="singleResidualBytes" else "4"
                seconds+=(case["splits"][size]["splitSeconds"]+case["splits"][size]["accountingSeconds"])/len(case["pages"])
            row={"quality":candidate["score"]["quality"],"pass":int(candidate["score"]["acceptable"]),"seconds":seconds,
                 "ocrCalls":sum(k!="native" for k in attempts),"selected":name}
            all_rows.append(row);slices[str(case["hardPercent"])].append(row);families[case["family"]].append(row)
            tiers[name]+=1
    aggregate=lambda rows:{"quality":mean([r["quality"] for r in rows]),"passRate":mean([r["pass"] for r in rows]),
                           "serviceSeconds":sum(r["seconds"] for r in rows),"pages":len(rows),"ocrCalls":sum(r["ocrCalls"] for r in rows)}
    result=aggregate(all_rows)
    result.update({"byHardPercent":{k:aggregate(v) for k,v in slices.items()},"byFamily":{k:aggregate(v) for k,v in families.items()},"selectedTiers":dict(tiers)})
    result["pagesPerMinute"]=len(all_rows)*60/max(1e-9,result["serviceSeconds"])
    result["minutesPer100Pages"]=result["serviceSeconds"]/max(1,len(all_rows))*100/60
    return result

def eligible(candidate,baseline):
    if candidate["quality"] < baseline["quality"]-.01 or candidate["passRate"] < baseline["passRate"]-.02:return False
    return all(s["quality"] >= baseline["byHardPercent"][key]["quality"]-.02 and
               s['passRate']>=baseline['byHardPercent'][key]['passRate']-.02 for key,s in candidate["byHardPercent"].items())

def search(cases):
    baseline=summarize(cases,{"mode":"ocr-strong"})
    rows=[]
    for mode in ['native','ocr-fast','ocr-strong']:
        policy={'mode':mode};result=summarize(cases,policy)
        rows.append({'policy':policy,'quality':result['quality'],'passRate':result['passRate'],'serviceSeconds':result['serviceSeconds'],'eligible':eligible(result,baseline)})
    for glyph,image,confidence,byte,vector,basis in itertools.product([.1,.2,.35,.5,.75], [.02,.1,.25,.5,.8,1.1], [0,60,80,90,101], [0,.01,.05], [100,1000000], ["contentDecodedBytes","singleResidualBytes","fourResidualBytes"]):
        if byte==0 and basis!="contentDecodedBytes":continue
        policy={"mode":"ladder","glyphThreshold":glyph,"imageThreshold":image,"confidenceThreshold":confidence,
                "byteThreshold":byte,"vectorThreshold":vector,"byteBasis":basis}
        result=summarize(cases,policy)
        rows.append({"policy":policy,"quality":result["quality"],"passRate":result["passRate"],"serviceSeconds":result["serviceSeconds"],"eligible":eligible(result,baseline)})
    result=summarize(cases,PROXY)
    rows.append({"policy":PROXY,"quality":result["quality"],"passRate":result["passRate"],"serviceSeconds":result["serviceSeconds"],"eligible":eligible(result,baseline)})
    feasible=sorted([r for r in rows if r["eligible"]],key=lambda r:(r["serviceSeconds"],r["policy"].get("byteThreshold",0)>0,r["policy"].get("glyphThreshold",0)))
    # No fabricated success when the local comparator or all candidate policies fail.
    policy=feasible[0]["policy"] if feasible else {"mode":"ocr-strong"}
    return policy,rows

def bootstrap(candidate,baseline):
    families=sorted(candidate["byFamily"])
    rng=random.Random(19131);draws=[];quality=[];acceptance=[]
    for _ in range(1000):
        sample=rng.choices(families,k=len(families))
        c=sum(candidate["byFamily"][f]["serviceSeconds"] for f in sample)
        b=sum(baseline["byFamily"][f]["serviceSeconds"] for f in sample)
        draws.append(1-c/max(b,1e-9))
        quality.append(mean([candidate['byFamily'][f]['quality']-baseline['byFamily'][f]['quality'] for f in sample]))
        acceptance.append(mean([candidate['byFamily'][f]['passRate']-baseline['byFamily'][f]['passRate'] for f in sample]))
    ci=lambda values:[sorted(values)[24],sorted(values)[974]]
    return {"serviceWorkSaving95CI":ci(draws),'qualityDifference95CI':ci(quality),'acceptanceDifference95CI':ci(acceptance),"resamplingUnit":"source-family","draws":1000}

def split_report(cases):
    if any('nativeLayoutSeconds' not in case for case in cases):
        raise RuntimeError('missing-layout-only-timing-use-new-run')
    result={}
    for size in ["1","4"]:
        original=sum(c["pdfBytes"] for c in cases);split=sum(c["splits"][size]["bytes"] for c in cases)
        result[size]={"storageMultiplier":split/max(1,original),"splitSeconds":sum(c["splits"][size]["splitSeconds"] for c in cases),
            "extractSeconds":sum(c["splits"][size]["extractSeconds"] for c in cases),"originalExtractSeconds":sum(c["nativeLayoutSeconds"] for c in cases),
            "originalSpatialCaptureSeconds":sum(c["nativeBboxSeconds"] for c in cases),
            "accountingSeconds":sum(c["splits"][size]["accountingSeconds"] for c in cases),
            "timingBasis":"pdftotext-layout-only",
            "changedNativeTokens":sum(not c["splits"][size]["nativeTokensEqual"] for c in cases),"documents":len(cases)}
    return result

def require_quality_evidence(case):
    """Text diagnostics alone cannot authorize formula-bearing routing claims."""
    for page in case['pages']:
        for candidate in page['candidates'].values():
            if candidate['score'].get('acceptanceEvidenceComplete') is not True:
                raise RuntimeError('incomplete-quality-evidence-no-policy-promotion')


def load_panel(run,split,identity):
    path=run/f'{split}-complete.json'
    inventory=json.loads(path.read_text());validate_complete_inventory(inventory,split)
    if inventory['evaluationIdentityHash']!=identity_hash(identity):raise RuntimeError('panel-identity-mismatch')
    panel_path=run/f'{split}-panel.json'
    panel=json.loads(panel_path.read_text())
    validate_panel_binding(inventory,panel,file_hash(panel_path))
    manifest=json.loads((run/'dataset-manifest.json').read_text())
    if identity_hash(manifest)!=identity['datasetCanonicalHash']:raise RuntimeError('changed-dataset-manifest')
    validate_panel_manifest(panel,manifest)
    cases=[]
    for expected in inventory['cases']:
        result_path=run/'cases'/split/f"{expected['id']}.json"
        if file_hash(result_path)!=inventory['resultHashes'][expected['id']]:raise RuntimeError('changed-result')
        case=json.loads(result_path.read_text())
        if any(case[k]!=expected[k] for k in ['id','family','split','hardPercent']) or len(case['pages'])!=10:raise RuntimeError('result-inventory-mismatch')
        wanted={'sourceHash':expected['sha256'],'labelHash':expected['labelHash'],'evaluationIdentityHash':identity_hash(identity),'policyHash':inventory['policyHash']}
        if case['caseIdentity']!=wanted:raise RuntimeError('result-provenance-mismatch')
        require_quality_evidence(case)
        cases.append(case)
    return cases,inventory

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument('--run',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--heldout-policy',type=Path);a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    # Reject a tuning restart BEFORE opening any completed result or heldout prediction.
    if not a.heldout_policy and (a.run/'heldout-panel.json').exists():raise RuntimeError('cannot-retune-after-heldout-access')
    identity=json.loads((a.run/'evaluation-identity.json').read_text())
    if a.heldout_policy:
        receipt=json.loads(a.heldout_policy.read_text())
        validate_policy_receipt(receipt,identity,sha(Path(__file__)),sha(a.run/'tune-complete.json'))
        inventory=json.loads((a.run/'heldout-complete.json').read_text())
        validate_complete_inventory(inventory,'heldout')
        if inventory['policyHash']!=sha(a.heldout_policy):raise RuntimeError('heldout-policy-binding-mismatch')
        selected,_=load_panel(a.run,'heldout',identity);policy=receipt['policy']
        if set(receipt['developmentFamilies']) & {c['family'] for c in selected}:raise RuntimeError('split-family-overlap')
    else:
        training,_=load_panel(a.run,'train',identity)
        selected,_=load_panel(a.run,'tune',identity)
        if {c['family'] for c in training}&{c['family'] for c in selected}:raise RuntimeError('split-family-overlap')
        _,grid=search(training)
        # Retain the fastest representative of each distinct training-page decision pattern.
        shortlist=[];seen=set()
        for row in sorted([r for r in grid if r['eligible']],key=lambda r:r['serviceSeconds']):
            signature=tuple(choose(p,row['policy'])[0] for c in training for p in c['pages'])
            if signature not in seen:seen.add(signature);shortlist.append(row['policy'])
            if len(shortlist)>=100:break
        for mode in ['native','ocr-fast','ocr-strong']:
            policy={'mode':mode}
            if policy not in shortlist:shortlist.append(policy)
        if PROXY not in shortlist:shortlist.append(PROXY)
        baseline=summarize(selected,{'mode':'ocr-strong'})
        validation=[{'policy':p,'result':summarize(selected,p)} for p in shortlist]
        feasible=[r for r in validation if eligible(r['result'],baseline)]
        winner=min(feasible,key=lambda r:r['result']['serviceSeconds'])
        policy=winner['policy']
        receipt={'schema':'mixed-pdf-policy@v2','policy':policy,'optimizerHash':sha(Path(__file__)),
                 'evaluationIdentity':identity,'tuningInventoryHash':sha(a.run/'tune-complete.json'),
                 'trainingInventoryHash':sha(a.run/'train-complete.json'),'candidateCount':len(grid),'shortlistCount':len(shortlist),
                 'developmentFamilies':sorted({c['family'] for c in training+selected})}
        immutable_json(a.out/'frozen-policy.json',receipt)
        immutable_json(a.out/'training-search.json',grid)
        immutable_json(a.out/'validation-shortlist.json',validation)
    result=summarize(selected,policy);strong=summarize(selected,{'mode':'ocr-strong'})
    baselines={name:summarize(selected,{'mode':name}) for name in ['native','ocr-fast','ocr-strong']}
    baselines['20-percent-proxy']=summarize(selected,PROXY)
    uncertainty=bootstrap(result,strong)
    report={'split':'heldout' if a.heldout_policy else 'tune','policy':policy,
            'policyHash':sha(a.heldout_policy or a.out/'frozen-policy.json'),
            'evaluationIdentityHash':identity_hash(identity),
            'inventoryHash':sha(a.run/('heldout-complete.json' if a.heldout_policy else 'tune-complete.json')),
            'result':result,'baselines':baselines,
            'constraintsPass':eligible(result,strong),'pointEstimateSpeedImprovement':result['serviceSeconds']<strong['serviceSeconds'],
            'qualityNoninferioritySupported':uncertainty['qualityDifference95CI'][0]>=-.01 and uncertainty['acceptanceDifference95CI'][0]>=-.02,
            'serviceWorkSaving':1-result['serviceSeconds']/max(1e-9,strong['serviceSeconds']),
            'uncertainty':uncertainty,'splitting':split_report(selected),
            'limitations':['Synthetic English families share templates','Service work is not end-to-end concurrent ingestion latency','No hosted-model dollar savings measured','Local OCR may fail even when the relative quality constraint passes','Four-page residual allocation is an equal-share proxy, not observed per-page storage']}
    immutable_json(a.out/(report['split']+'-report.json'),report)
    print(json.dumps({'split':report['split'],'policy':policy,'quality':result['quality'],'passRate':result['passRate'],'workSaving':report['serviceWorkSaving'],'constraintsPass':report['constraintsPass']}))
