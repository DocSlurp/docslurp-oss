#!/usr/bin/env python3
"""Hash authored candidates and partition whole related-source components before evaluation.

This metadata operation never renders images, reads predictions, or admits a benchmark.
"""
import argparse, collections, copy, datetime, hashlib, json, random
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--native-only', action='store_true')
    p.add_argument('--lock', action='store_true', help='Publish immutable split hash lock after independent metadata refresh')
    args = p.parse_args(); root = args.root.resolve()
    native_path = root / 'pilot-manifest.jsonl'
    native = [json.loads(s) for s in native_path.read_text().splitlines()]
    receipts = []
    for row in native:
        m = row['metadata']; ident = row['id']
        paths = {'image': root / row['image_path'], 'source': root / m['source_path'],
                 'reference': root / m['reference_path'], 'expected': root / m['expected_markdown']['path'],
                 'contract': root / m['prose_contract']['path'],
                 'confidence': root / m['annotation_confidence']['receipt_path']}
        hashes = {k: sha(v) for k,v in paths.items()}
        assert hashes['image'] == m['image_sha256'] and hashes['source'] == m['source_sha256'], ident
        assert hashes['expected'] == m['expected_markdown']['sha256'], ident
        assert hashes['contract'] == m['prose_contract']['sha256'], ident
        confidence = json.loads(paths['confidence'].read_text())
        for k, key in [('image','imageSha256'),('source','sourceSha256'),('reference','referenceSha256')]:
            assert confidence['artifacts'][key] == hashes[k], (ident,key)
        receipts.append({'id': ident, 'artifacts': {k:{'path': str(v.relative_to(root)), 'sha256':hashes[k]} for k,v in paths.items()}})
    freeze = root / 'native-freeze-v2.json'
    payload = {'schema':'layout-native-freeze-v2','count':len(native),'nativeManifestSha256':sha(native_path),
               'status':'immutable-source-candidates; independent QA/publication/evaluation admission separate',
               'artifacts':receipts}
    if freeze.exists():
        previous = json.loads(freeze.read_text())
        assert previous == payload, 'Native bytes changed after freeze'
    else: dump(freeze,payload)
    if args.native_only:
        print(json.dumps({'native':len(native),'freeze':str(freeze),'sha256':sha(freeze)}));return
    inputs = [(native_path, native)]
    for name in ['captures/pilot-capture-manifest.jsonl','historical-silver/manualmanifest.jsonl']:
        f = root/name
        inputs.append((f,[json.loads(s) for s in f.read_text().splitlines()]))
    rows = []
    for path,items in inputs:
        for item in items:
            row = copy.deepcopy(item); meta = row.setdefault('metadata',{})
            # Canonical input-image path is absolute: independent split files resolve identically.
            im = Path(row['image_path']); im = im if im.is_absolute() else path.parent/im
            row['image_path'] = str(im.resolve()); meta['image_sha256'] = sha(im)
            for key in ['source_path','reference_path']:
                if key in meta:
                    v=Path(meta[key]);meta[key]=str(v if v.is_absolute() else path.parent/v)
            meta['input_manifest'] = str(path);meta['input_manifest_sha256'] = sha(path)
            meta.setdefault('source_id',row['id']);meta.setdefault('document_id',meta['source_id'])
            rows.append(row)
    # All images and references must exist; this checks applicability without claiming semantic QA.
    artifacts=[]
    for row in rows:
        record={'id':row['id'],'imageSha256':sha(row['image_path'])}
        reference=row.get('reference_path') or row['metadata'].get('reference_path')
        if reference:
            rp=Path(reference)
            if not rp.is_absolute():rp=Path(row['metadata']['input_manifest']).parent/rp
            record['referencePath']=str(rp);record['referenceSha256']=sha(rp)
        for region in row['regions']:
            x0,y0,x1,y1=region['bbox']
            if not (0<=x0<=x1<=row['width']+.001 and 0<=y0<=y1<=row['height']+.001):
                raise ValueError((row['id'],region['id'],'region outside raster'))
        artifacts.append(record)
    ids = [r['id'] for r in rows]; assert len(ids)==len(set(ids))
    parent = {i:i for i in ids}; joins=[]; seen={}
    def find(x):
        while parent[x]!=x: parent[x]=parent[parent[x]];x=parent[x]
        return x
    def key(kind,value,ident):
        if not value:return
        token=(kind,value)
        if token in seen:
            other=seen[token]; a,b=find(ident),find(other)
            if a!=b:parent[max(a,b)]=min(a,b)
            joins.append({'kind':kind,'value':value,'ids':[other,ident]})
        else:seen[token]=ident
    for row in rows:
        i=row['id'];m=row['metadata']
        key('source_id',m['source_id'],i);key('document_id',m['document_id'],i)
        key('image_sha256',m['image_sha256'],i)
        # Full-image inserts and scene plates create source leakage; formula glyphs/fonts do not.
        key('scene_sha256',m.get('scene_sha256'),i)
        for region in row['regions']:
            if region['label'] not in ['photo','illustration']:continue
            asset=region.get('attributes',{}).get('asset',{})
            if isinstance(asset,dict):key('full_image_asset_sha256',asset.get('sha256'),i)
    groups=collections.defaultdict(list)
    for i in ids:groups[find(i)].append(i)
    clusters={f'group-{n:02d}':sorted(v) for n,v in enumerate(sorted(groups.values()),1)}
    membership={i:c for c,members in clusters.items() for i in members}
    # Deterministic coverage balancing uses annotations only, never model outcomes.
    labels={c:set(r['label'] for row in rows if row['id'] in members for r in row['regions']) for c,members in clusters.items()}
    all_labels=set().union(*labels.values())
    repeated={label for label in all_labels if sum(label in v for v in labels.values())>1}
    rng=random.Random(20261020); best=None
    for attempt in range(6000):
        held=set(rng.sample(sorted(clusters),7))
        # Unique authored continuation-table and glyph-clipped-table mechanisms must be
        # available for development; no independent heldout equivalents exist yet.
        development_only_sources={'business-meridian-invoice-1','instruments-rainfall-field-log','water-cycle-field-notebook','maple-lantern-1994-takeout-menu'}
        if any(development_only_sources.intersection(clusters[c]) for c in held):continue
        dev_labels=set().union(*(labels[c] for c in clusters if c not in held))
        if dev_labels != all_labels:continue
        hold_labels=set().union(*(labels[c] for c in held))
        n=sum(len(clusters[c]) for c in held)
        objective=(len(repeated-hold_labels),abs(n-10),tuple(sorted(held)))
        if best is None or objective<best[0]:best=(objective,held)
    assert best is not None
    assignment={c:('holdout' if c in best[1] else 'dev') for c in clusters}
    out=root/'frozen-v2';out.mkdir(exist_ok=True)
    for row in rows:
        c=membership[row['id']]; row['split']=assignment[c];row['metadata']['source_cluster']=c
        row['metadata']['evaluation_admission']='pending-coordinator-contract-and-independent-gates'
    coverage={s:dict(collections.Counter(r['label'] for row in rows if row['split']==s for r in row['regions'])) for s in ['dev','holdout']}
    all_labels=set().union(*(set(v) for v in coverage.values()))
    gaps={s:sorted(all_labels-set(coverage[s])) for s in coverage}
    receipts={str(path.relative_to(root)):sha(path) for path,_ in inputs}
    serialized={f'{s}.jsonl':''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows if r['split']==s) for s in ['dev','holdout']}
    serialized['candidates.jsonl']=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
    lock_path=out/'LOCK.json'
    if lock_path.exists():
        lock=json.loads(lock_path.read_text())
        for name,value in serialized.items():
            if hashlib.sha256(value.encode()).hexdigest()!=lock['outputs'][name]:
                raise ValueError('Inputs changed after split lock: '+name)
    for name,value in serialized.items():(out/name).write_text(value)
    report={'schema':'layout-source-group-split-v2','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'inputs':receipts,'candidateArtifacts':artifacts,'nativeFreezeSha256':sha(freeze),'candidateCount':len(rows),'nativeCount':len(native),
            'clusters':clusters,'source_to_cluster':membership,'join_receipts':joins,'assignment':assignment,
            'policy':'whole-source/document/exact-image/full-insert/scene transitive closure; 6000 seeded metadata-only candidate assignments, seven heldout groups; retain every label plus unique continuation-table and glyph-clipped-table mechanisms in dev, maximize repeated-label holdout coverage, target10 heldout images; no outcomes read; no train set',
            'splitCounts':dict(collections.Counter(r['split'] for r in rows)),
            'groupCounts':dict(collections.Counter(assignment.values())), 'regionLabelCounts':coverage,'missingLabels':gaps,
            'limitations':['Small deliberately authored pilot pool, not representative population or 200 independent pages.',
                            'Unique Chinese-menu, handwritten historic, Arabic-form, mind-map, continuation-table and cropped-table sources cannot each appear in both splits.',
                            'Continuation-table, glyph-clipped-table, Chinese menu and all shared-scene photographic capture groups are explicitly reserved for development; independent heldout confirmation of these mechanisms is unavailable.',
                            'Shared full-image and scene closure can confound photographic capture with source group.',
                            'No benchmark or publication admission implied. QA/rights/tag overlays are separate hash-pinned artifacts.'],
            'outputs':{n:sha(out/n) for n in ['dev.jsonl','holdout.jsonl','candidates.jsonl']}}
    if not lock_path.exists():dump(out/'split-receipt.json',report)
    if args.lock and not lock_path.exists():
        dump(lock_path,{'schema':'layout-v2-split-lock','createdAt':report['createdAt'],'outputs':report['outputs'],
                        'splitReceiptSha256':sha(out/'split-receipt.json'),'nativeFreezeSha256':sha(freeze),
                        'software':{p.name:sha(p) for p in Path(__file__).parent.glob('*.py')},
                        'admission':'candidate source lock only; separate QA, rights and evaluation-integrity gates required'})
    print(json.dumps({k:report[k] for k in ['candidateCount','splitCounts','groupCounts','missingLabels','clusters']},indent=2))

if __name__=='__main__':main()
