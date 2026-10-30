#!/usr/bin/env python3
"""Source-blind ATTEMPT4 corpus builder. Local graphics only, no API clients.

Default: exactly families 0, 6, 12, six hard cases each. Pilot/full stages require
an external coordinator approval, audit and judge gates, and exact frozen
handoff hash. Never reuse an existing output directory or overwrite a revision.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import copy
import json
import os
from pathlib import Path
import sys
import traceback

for _key in ['OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS']:
    os.environ.setdefault(_key,'1')
for _key in ['TMPDIR','TMP','TEMP']:os.environ.setdefault(_key,'/home/dan/tmp/agents')

from fools_gold_v4_common import *


def handoff_hash(md,json_path):
    return sha(canonical({'spec-a4.md':file_hash(md),'spec-a4.json':file_hash(json_path)}))


def approve_stage(stage,bundle,approval,frozen):
    if frozen and frozen!=bundle:raise ValueError('Frozen handoff hash mismatch')
    if stage=='prototypes':return
    if frozen!=bundle:raise ValueError('pilot/full requires exact --frozen-handoff-hash')
    if approval is None:raise ValueError('pilot/full requires external --coordinator-approval')
    a=load(approval)
    if a.get('stage')!=stage or a.get('handoffHash')!=bundle or a.get('coordinatorApproval') is not True:raise ValueError('Coordinator stage/hash approval missing or mismatched')
    for kind in ['audit','judge']:
        verdict=a.get(kind,{})
        if verdict.get('score',0)<95:raise ValueError(kind+' gate below 95')
        for key in ['fatal','high','unresolvedMedium','unresolvedSubstantive']:
            if verdict.get(key)!=0:raise ValueError(kind+' has missing/unresolved '+key)
        if verdict.get('lowCosmetic',100)>5:raise ValueError(kind+' has more than five low cosmetic misses')
    if stage=='full' and a.get('balancedPilotApproved') is not True:raise ValueError('Full build requires balanced pilot approval')


def build_family(task):
    from fools_gold_v4_content import family_world
    from fools_gold_v4_native import author,render_native
    from fools_gold_v4_transforms import plans_for_family,isolated_assets,build_case
    from fools_gold_v4_check import authoring_checks,compare_native,pdf_profile
    root=Path(task['root']);spec=task['spec'];family=task['family'];fid=family['familyId'];source=root/f'sources/{fid:04d}'
    source.mkdir(parents=True)
    os.environ['MPLCONFIGDIR']=str(source/'mpl-cache')
    world=freeze(family_world(family),'worldHash');save(source/'world.json',world)
    authored,resolved=author(spec,family,world,task['specHash'])
    validate_schema(authored,spec['immutable_records']['schemas']['authoring'])
    check=authoring_checks(spec,family,authored,world);save(source/'authoring-check.json',check)
    if not check['passed']:raise ValueError('Authoring gate failed: '+json.dumps(check['misses'][:12]))
    save(source/'authoring.json',authored);save(source/'source-layout.json',resolved)
    native=render_native(authored,resolved,world,source)
    proof={k:str(v) if isinstance(v,Path) else v for k,v in native.items()};save(source/'producer-proof.json',proof)
    actual=compare_native(authored,native['pdf'],spec=spec,family=family);save(source/'native-glyph-check.json',actual)
    save(source/'native-profile.json',pdf_profile(native['pdf']))
    if not actual['passed']:raise ValueError('Actual native glyph gate failed: '+json.dumps(actual['misses'][:2]))
    plans=plans_for_family(spec,family,authored,file_hash(native['pdf']))
    for plan,exclusion in plans:
        validate_schema(plan,spec['immutable_records']['schemas']['transform_plan']);validate_schema(exclusion,spec['immutable_records']['schemas']['exclusion_plan'])
        save(root/f'plans/{fid:04d}/{plan["hardPercent"]}.json',plan);save(root/f'plans/{fid:04d}/{plan["hardPercent"]}-exclusions.json',exclusion)
    print(json.dumps(dict(event='native-frozen',family=fid,pages=10,authoringHash=authored['authoringHash'],nativeHash=file_hash(native['pdf']))),flush=True)
    composite,assets,omitted=isolated_assets(spec,family,authored,resolved,world,source,plans[0][0])
    remaining=source/'transform-native/remaining.pdf';isolated_check=compare_native(authored,remaining,omitted);save(source/'remaining-glyph-check.json',isolated_check)
    if not isolated_check['passed']:raise ValueError('Native omission leaked/removed neighboring glyphs: '+json.dumps(isolated_check['misses'][:2]))
    composite_check=compare_native(authored,composite,omitted);save(source/'composite-native-leakage-check.json',composite_check)
    if not composite_check['passed']:raise ValueError('Composite has native leakage or removed neighboring glyphs')
    cases=[]
    for plan,exclusion in plans:
        case=build_case(root,spec,family,authored,world,plan,exclusion,composite,assets);cases.append(case)
        print(json.dumps(dict(event='case-written',family=fid,hardPercent=case['hardPercent'],pages=10,sha256=case['sha256'])),flush=True)
    return cases


def preview_pages(root,cases):
    import fitz
    from PIL import Image,ImageDraw
    directory=root/'previews';directory.mkdir()
    tiles=[];observed=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
    for case in cases:
        if case['hardPercent'] not in [0,100]:continue
        with fitz.open(root/case['pdf']) as doc:
            for pnum in [1,2,3,4,8,9]:
                page=doc[pnum-1];image_path=directory/(case['id']+f'-p{pnum:02d}.png')
                page.get_pixmap(dpi=150).save(image_path)
                # Actual 150-DPI table/math crops, not redrawn authoring data.
                page.set_rotation(0);a=load(root/f'sources/{case["familyId"]:04d}/authoring.json');blocks=a['pages'][pnum-1]['blocks']
                clip=union_box(b['containerPt'] for b in blocks if b['templateId'] in ['matrix.title','matrix.table','math.rule','math.constraint'])
                page.get_pixmap(dpi=250,clip=fitz.Rect(clip)+(-4,-4,4,4)).save(directory/(case['id']+f'-p{pnum:02d}-technical.png'))
                if pnum in [1,4,9]:
                    im=Image.open(image_path).convert('RGB');im.thumbnail((340,440));tile=Image.new('RGB',(360,480),'#e8edf1');tile.paste(im,((360-im.width)//2,22));ImageDraw.Draw(tile).text((8,460),f'f{case["familyId"]:04d}  hard {case["hardPercent"]}%  p{pnum}',fill='#13212a');tiles.append(tile)
    sheet=Image.new('RGB',(360*6,480*math_ceil(len(tiles)/6)),'white')
    for i,tile in enumerate(tiles):sheet.paste(tile,((i%6)*360,(i//6)*480))
    sheet.save(directory/'prototype-contact-sheet.png')
    save(directory/'provenance.json',dict(observedAt=observed,source='actual delivered PDFs; PyMuPDF 150 DPI plus 250 DPI technical close-ups',files=[p.name for p in directory.glob('*.png')]))


def math_ceil(x):return int(-(-x//1))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--spec-json',type=Path,required=True);p.add_argument('--spec-md',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--stage',choices=['prototypes','factorial-pilot','full'],default='prototypes')
    p.add_argument('--workers',type=int,choices=range(1,4),default=1);p.add_argument('--frozen-handoff-hash');p.add_argument('--coordinator-approval',type=Path)
    p.add_argument('--plan-only',action='store_true');p.add_argument('--repeat-of',type=Path)
    args=p.parse_args();spec=load(args.spec_json);bundle=handoff_hash(args.spec_md,args.spec_json)
    family_ids=[0,6,12] if args.stage=='prototypes' else list(range(18)) if args.stage=='factorial-pilot' else list(range(90))
    if args.plan_only:
        print(json.dumps(dict(handoffHash=bundle,stage=args.stage,families=[spec['dataset']['family_plan'][i] for i in family_ids],executionAuthorizedNow=args.stage=='prototypes'),indent=2));return 0
    approve_stage(args.stage,bundle,args.coordinator_approval,args.frozen_handoff_hash)
    root=args.output
    if root.exists():raise FileExistsError('New immutable output directory required: '+str(root))
    root.mkdir(parents=True)
    save(root/'handoff/spec-a4.md',args.spec_md.read_bytes());save(root/'handoff/spec-a4.json',args.spec_json.read_bytes())
    code={}
    for file in sorted(Path(__file__).parent.glob('fools_gold*v4*.py')):
        if file.name not in ['fools_gold_build_v4.py'] and not file.name.startswith('fools_gold_v4_'):continue
        save(root/'builder-source'/file.name,file.read_bytes());code[file.name]=file_hash(file)
    preflight=dict(schema='mixed-pdf-preflight@4',handoffHash=bundle,specHash=file_hash(args.spec_json),tools=versions(),builderFiles=code,stage=args.stage,workers=args.workers,resources=dict(cpuLogicalLimit=3,familyWorkers=args.workers,apiCalls=0,externalCostUsd=0),status='unaccepted-build; no audit or judge score')
    save(root/'preflight.json',preflight)
    if args.coordinator_approval:save(root/'coordinator-approval.json',args.coordinator_approval.read_bytes())
    tasks=[dict(root=str(root),spec=spec,family=spec['dataset']['family_plan'][i],specHash=file_hash(args.spec_json)) for i in family_ids]
    cases=[]
    try:
        if args.workers==1:
            for task in tasks:cases.extend(build_family(task))
        else:
            with ProcessPoolExecutor(max_workers=args.workers) as pool:
                pending=[pool.submit(build_family,t) for t in tasks]
                for f in as_completed(pending):cases.extend(f.result())
        cases.sort(key=lambda c:(c['familyId'],c['hardPercent']))
        manifest=freeze(dict(schema='mixed-pdf-manifest@4',stage=args.stage,handoffHash=bundle,specHash=file_hash(args.spec_json),builderSourceHashes=code,cases=cases,counts=dict(families=len(family_ids),pdfs=len(cases),pages=sum(c['pages'] for c in cases)),status='UNACCEPTED: coordinator audit and independent judge pending'),'manifestHash')
        save(root/'manifest.json',manifest)
        # No discretionary previews of a heldout full build.
        if args.stage!='full':preview_pages(root,cases)
        from fools_gold_v4_check import check_corpus
        result=check_corpus(root,spec);save(root/'structural-check.json',result)
        if args.repeat_of:
            original=load(args.repeat_of/'manifest.json');lookup={c['id']:c for c in original['cases']};comparisons=[]
            for case in cases:
                other=lookup[case['id']];comparisons.append(dict(id=case['id'],pdfBytesIdentical=case['sha256']==other['sha256'],labelsBytesIdentical=case['labelHash']==other['labelHash'],nativeBytesIdentical=case['nativePdfHash']==other['nativePdfHash'],firstSha256=other['sha256'],repeatSha256=case['sha256']))
            save(root/'repeat-byte-comparison.json',dict(sameHandoff=original['handoffHash']==bundle,sameCode=original['builderSourceHashes']==code,cases=comparisons,allPdfBytesIdentical=all(c['pdfBytesIdentical'] for c in comparisons),allLabelBytesIdentical=all(c['labelsBytesIdentical'] for c in comparisons)))
        inventory=freeze(dict(schema='mixed-pdf-artifact-inventory@4',manifestHash=manifest['manifestHash'],files={str(path.relative_to(root)):dict(sha256=file_hash(path),bytes=path.stat().st_size) for path in sorted(root.rglob('*')) if path.is_file()}),'inventoryHash')
        save(root/'artifact-hashes.json',inventory)
        print(json.dumps(dict(event='finished',output=str(root),counts=manifest['counts'],structuralPassed=result['passed'],acceptance='pending external audit and judge')),flush=True)
        return 0 if result['passed'] else 1
    except Exception:
        save(root/'BUILD-FAILURE.txt',traceback.format_exc());raise


if __name__=='__main__':raise SystemExit(main())
