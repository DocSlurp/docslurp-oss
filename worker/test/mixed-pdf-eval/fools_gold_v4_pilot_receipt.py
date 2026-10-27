"""Exact-manifest pilot receipt. Refuses missing/incomplete pilot records.

Run only on an existing, fully generated 18-family corpus. This never renders
or generates missing records, or borrows prototype success for enriched cases.
"""
import argparse
import datetime
import sys
from fools_gold_v4_common import *


def receipt(root,spec_path,spec_md,prototype_root,output):
    from fools_gold_build_v4 import handoff_hash
    from fools_gold_v4_check import check_corpus,label_authoring,authoring_checks
    from fools_gold_v4_semantic import semantic_checks
    root=Path(root).resolve();output=Path(output).resolve();snapshot=output.parent/(output.stem+'-snapshot')
    if output.exists() or snapshot.exists():raise FileExistsError('new receipt/snapshot revision required')
    if output.is_relative_to(root) or snapshot.is_relative_to(root):raise ValueError('receipt must remain outside immutable corpus')
    manifest=load(root/'manifest.json');manifest_sha=file_hash(root/'manifest.json');spec=load(spec_path)
    if record_hash(manifest,'manifestHash')!=manifest['manifestHash']:raise ValueError('manifest hash differs')
    bundle=handoff_hash(spec_md,spec_path)
    if manifest['handoffHash']!=bundle or manifest['stage']!='factorial-pilot':raise ValueError('stage/handoff mismatch')
    expected={(i,h) for i in range(18) for h in [0,20,40,60,80,100]}
    actual=[(c['familyId'],c['hardPercent']) for c in manifest['cases']]
    if len(actual)!=108 or set(actual)!=expected:raise ValueError('exact 18-family, 108-case pilot required')
    if any(c['split']!='train' or c['pages']!=10 for c in manifest['cases']):raise ValueError('training/ten-page contract differs')
    if manifest['counts']!=dict(families=18,pdfs=108,pages=1080):raise ValueError('manifest counts differ')
    protected={}
    inventory=load(root/'artifact-hashes.json')
    if record_hash(inventory,'inventoryHash')!=inventory['inventoryHash']:raise ValueError('inventory self hash differs')
    for relative,item in inventory['files'].items():
        path=(root/relative).resolve()
        if not path.is_relative_to(root):raise ValueError('inventory escape')
        digest=file_hash(path)
        if digest!=item['sha256']:raise ValueError('original artifact differs: '+relative)
        protected[relative]=digest
    protected['artifact-hashes.json']=file_hash(root/'artifact-hashes.json')
    code=Path(__file__).parent;names=['fools_gold_build_v4.py']+sorted(p.name for p in code.glob('fools_gold_v4_*.py'))
    for name in names:save(snapshot/name,(code/name).read_bytes())
    code_hashes={name:file_hash(snapshot/name) for name in names}
    original_manifest=load(Path(prototype_root)/'manifest.json');original_manifest_sha=file_hash(Path(prototype_root)/'manifest.json')
    original_pdf_hashes={c['id']:file_hash(Path(prototype_root)/c['pdf']) for c in original_manifest['cases']}
    misses=[];families=[];cache={};cases=[]
    for fid in range(18):
        source=root/f'sources/{fid:04d}';a=load(source/'authoring.json');world=load(source/'world.json');reference=load(source/'source-layout.json');family=spec['dataset']['family_plan'][fid]
        case=next(c for c in manifest['cases'] if c['familyId']==fid)
        expected_page_hashes=[page_content_hash(p) for p in a['pages']]
        family_cases=[c for c in manifest['cases'] if c['familyId']==fid]
        if any(c.get('pageContentHashes')!=expected_page_hashes for c in family_cases):raise ValueError('missing/reordered pageContentHashes before label reads')
        validate_schema(a,spec['immutable_records']['schemas']['authoring'])
        if file_hash(source/'source-layout.json')!=case['sourceLayoutHash']:raise ValueError('unbound printed reference')
        result=authoring_checks(spec,family,a,world,reference,case['worldHash']);misses.extend(result['misses'])
        families.append(dict(familyId=fid,authoringSha256=file_hash(source/'authoring.json'),worldSha256=file_hash(source/'world.json'),authoringHash=a['authoringHash'],worldHash=world['worldHash'],sourceLayoutSha256=file_hash(source/'source-layout.json'),result=result));cache[fid]=(a,world,reference,family)
        for name in ['native-glyph-check.json','remaining-glyph-check.json','composite-native-leakage-check.json']:
            check=load(source/name)
            if not check['passed']:misses.append(dict(kind='retained-render-gate-failed',location=f'{fid:04d}/{name}',detail=check['misses']))
    structural=check_corpus(root,spec);save(snapshot/'structural-check.json',structural);misses.extend(structural['misses'])
    for case in manifest['cases']:
        a,world,reference,family=cache[case['familyId']];label=load(root/case['labels']);projection=label_authoring(a,label)
        validate_schema(projection,spec['immutable_records']['schemas']['authoring'])
        result=semantic_checks(projection,world,family,reference,case['worldHash'],tolerance_range=[.1,.9]);misses.extend(result['misses'])
        cases.append(dict(id=case['id'],authoringHash=a['authoringHash'],worldHash=world['worldHash'],labelSha256=file_hash(root/case['labels']),pdfSha256=file_hash(root/case['pdf']),schemaPassed=True,result=dict(passed=result['passed'],checkedPages=result['checkedPages'],misses=result['misses'])))
    comparisons=[]
    for old in original_manifest['cases']:
        case=next(c for c in manifest['cases'] if c['id']==old['id'])
        comparisons.append(dict(id=old['id'],originalSha256=old['sha256'],originalActualSha256=original_pdf_hashes[old['id']],pilotSha256=case['sha256'],pilotPdfBytesIdentical=case['sha256']==old['sha256']))
    unchanged=all(file_hash(root/relative)==digest for relative,digest in protected.items()) and all(file_hash(Path(prototype_root)/c['pdf'])==c['sha256']==original_pdf_hashes[c['id']] for c in original_manifest['cases']) and file_hash(Path(prototype_root)/'manifest.json')==original_manifest_sha
    if not unchanged:misses.append(dict(kind='immutable-artifacts-changed',location='corpus',detail='before/after hash differs'))
    if file_hash(root/'manifest.json')!=manifest_sha:raise ValueError('manifest changed during receipt')
    if any(file_hash(code/n)!=digest or file_hash(snapshot/n)!=digest for n,digest in code_hashes.items()):raise ValueError('validator code changed during receipt')
    result=freeze(dict(schema='mixed-pdf-semantic-revalidation@1',handoffHash=bundle,corpusManifestSha256=manifest_sha,corpusManifestHash=manifest['manifestHash'],passed=not misses,originalCorpusUnchanged=unchanged,counts=dict(authoringPages=sum(f['result']['checkedPages'] for f in families),labelPages=sum(c['result']['checkedPages'] for c in cases),pdfsHashed=len(cases)),checkedFamilies=families,checkedCases=cases,validatorCodeSha256=code_hashes,validatorDependencySha256={n:h for n,h in code_hashes.items() if n not in ['fools_gold_v4_check.py','fools_gold_v4_semantic.py','fools_gold_v4_semantic_enriched.py']},validationSnapshot=str(snapshot),structuralReportSha256=file_hash(snapshot/'structural-check.json'),originalPrototypeManifestSha256=original_manifest_sha,prototypePdfComparison=comparisons,misses=misses,completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),acceptance='not assessed; independent enriched audit/judge required'),'receiptHash')
    save(snapshot/'snapshot-hashes.json',freeze(dict(schema='mixed-pdf-validator-snapshot@1',validatorCodeSha256=code_hashes,dependencySha256=result['validatorDependencySha256'],files={str(p.relative_to(snapshot)):file_hash(p) for p in sorted(snapshot.rglob('*')) if p.is_file()}),'snapshotHash'))
    result['snapshotHashesSha256']=file_hash(snapshot/'snapshot-hashes.json');freeze(result,'receiptHash');save(output,result);return result


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--spec',type=Path,required=True);p.add_argument('--spec-md',type=Path,required=True);p.add_argument('--prototype-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    result=receipt(a.root,a.spec,a.spec_md,a.prototype_root,a.output);print(dict(passed=result['passed'],counts=result['counts'],receiptHash=result['receiptHash']));raise SystemExit(0 if result['passed'] else 1)
