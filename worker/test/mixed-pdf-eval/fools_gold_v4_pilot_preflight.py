"""Non-promoting pilot preflight: retain exact contract failures and diagnostics.

This does not authorize or seal a corpus. No full/pilot generation occurs here.
A failed strict preflight remains a failed result, including rendered diagnostics.
"""
import argparse
from collections import Counter
import datetime
import shutil
import string
import traceback
from fools_gold_v4_common import *


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args();root=args.output
    if root.exists():raise FileExistsError(root)
    root.mkdir(parents=True)
    code=Path(__file__).parent;names=['fools_gold_build_v4.py']+sorted(f.name for f in code.glob('fools_gold_v4_*.py'))
    for name in names:save(root/'code'/name,(code/name).read_bytes())
    handoff=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a4')
    for name in ['spec-a4.md','spec-a4.json']:save(root/'handoff'/name,(handoff/name).read_bytes())
    approval=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a4/factorial-pilot-approval.json');save(root/'approval.json',approval.read_bytes())
    from fools_gold_build_v4 import handoff_hash,approve_stage
    from fools_gold_v4_content import family_world
    from fools_gold_v4_native import author,render_native
    from fools_gold_v4_check import authoring_checks,compare_native
    from fools_gold_v4_semantic import semantic_checks
    from fools_gold_v4_transforms import hard_image
    from fontTools.ttLib import TTFont
    import fitz,numpy as np
    spec=load(handoff/'spec-a4.json');bundle=handoff_hash(handoff/'spec-a4.md',handoff/'spec-a4.json')
    expected='fbb79e1c79065e771877c561847c9728caeff4bdb05ecd3cf86cfa0dfc832314'
    if bundle!=expected:raise ValueError('handoff mismatch')
    approve_stage('factorial-pilot',bundle,approval,expected)
    rows=[];rendered=None;observed=datetime.datetime.now(datetime.timezone.utc).isoformat()
    for family in spec['dataset']['family_plan'][:18]:
        if family['classId']=='P':continue
        fid=family['familyId'];source=root/f'authoring/{fid:04d}';world=freeze(family_world(family),'worldHash');save(source/'world.json',world)
        try:
            a,r=author(spec,family,world,file_hash(handoff/'spec-a4.json'))
            save(source/'authoring.json',a);save(source/'source-layout.json',r)
            validate_schema(a,spec['immutable_records']['schemas']['authoring'])
            check=authoring_checks(spec,family,a,world);save(source/'authoring-check.json',check)
            rows.append(dict(familyId=fid,classId=family['classId'],layoutId=family['layoutId'],schemaPassed=True,check=check))
            # Retain one complete failing Writer native as actual evidence.
            # It never enters a delivered corpus or receives a passing seal.
            if fid==5:
                native=render_native(a,r,world,source/'native-diagnostic');rendered=native['pdf']
                save(source/'native-diagnostic/producer-proof.json',{k:str(v) if isinstance(v,Path) else v for k,v in native.items()})
                actual=compare_native(a,rendered,spec=spec,family=family);save(source/'native-diagnostic/glyph-check.json',actual)
                with fitz.open(rendered) as doc:
                    page=doc[0];preview=root/'previews';preview.mkdir()
                    page.get_pixmap(dpi=150).save(preview/'f0005-p01-native.png')
                    clip=fitz.Rect(32,390,455,462);page.get_pixmap(dpi=300,clip=clip).save(preview/'f0005-p01-math-native-closeup.png')
                    op=dict(dpi=85,skewDegrees=-.6,blurSigmaPixels=.2,contrastMultiplier=.84,noiseSigma255=0,seed=family['transformSeed'],jpegQuality=54)
                    geom=hard_image(page,op,preview/'f0005-p01-hard-diagnostic.jpg');out=fitz.open();target=out.new_page(width=612,height=792)
                    target.insert_image(fitz.Rect(geom['placement']),stream=(preview/'f0005-p01-hard-diagnostic.jpg').read_bytes())
                    save(preview/'f0005-p01-hard-diagnostic.pdf',out.tobytes());target.get_pixmap(dpi=150).save(preview/'f0005-p01-hard-diagnostic.png')
                    target.get_pixmap(dpi=300,clip=clip).save(preview/'f0005-p01-math-hard-closeup.png');out.close()
                save(root/'previews/provenance.json',dict(observedAt=observed,source='actual whole LibreOffice Writer native export and one explicitly failed diagnostic hard scan; not delivered pilot cases',nativePdfSha256=file_hash(rendered),scanParameters=op,scanGeometry=geom))
        except Exception:
            failure=traceback.format_exc();save(source/'AUTHORING-FAILURE.txt',failure)
            rows.append(dict(familyId=fid,classId=family['classId'],layoutId=family['layoutId'],passed=False,error=failure))
        print(json.dumps(dict(event='preflight',familyId=fid,authored='check' in rows[-1],passed=rows[-1].get('check',{}).get('passed',False))),flush=True)
    # Independent, deliberately generous upper bound: count EVERY character
    # as one full-width mono glyph and grant the entire 24 pt height. Fractions
    # and subscripts ordinarily make support smaller. No tracking or padding.
    font=font_paths()['mono'];tt=TTFont(font);cmap=tt.getBestCmap();up=tt['head'].unitsPerEm
    advances={ch:tt['hmtx'][cmap[ord(ch)]][0]/up for ch in string.printable if ord(ch) in cmap}
    target=spec['enriched_derivatives']['E1']['layouts']['A']['blocks'];target=next(b for b in target if b['id']=='math.rule')
    q=next(r for r in spec['formula_shape_library'] if r['id']=='Q');fontmax=target['typography']['font_size_pt']+target['tolerances']['font_size_pt']
    maxwidth=q['display_character_range'][1]*max(advances.values())*fontmax;width=target['bbox_pt'][2]-target['bbox_pt'][0]
    bound=dict(recipe='Q',template='enriched_derivatives.E1.layouts.A.blocks[math.rule]',recipeCharacterRange=q['display_character_range'],fontPath=str(font),fontSha256=file_hash(font),fontUnitsPerEm=up,maxPrintableAdvanceEm=max(advances.values()),fontSizeMaximumIncludingTolerancePt=fontmax,targetWidthPt=width,targetHeightPt=24,maxSupportWidthPt=maxwidth,maximumIoUUpperBound=maxwidth/width,minimumIoU=.7,assumptions='Prescribed Liberation Mono, canonical printed character budget includes prefix; no added tracking, repeated padding spaces, glyph stretching or counting empty frame as occupied support.',conflict=maxwidth/width<.7)
    constraint=next(b for b in spec['enriched_derivatives']['E2']['layouts']['A']['blocks'] if b['id']=='math.constraint')
    cwidth=constraint['bbox_pt'][2]-constraint['bbox_pt'][0]
    cfont=constraint['typography']['font_size_pt']+constraint['tolerances']['font_size_pt']
    cmax=constraint['budget']['characters'][1]*max(advances.values())*cfont
    second=dict(template='enriched_derivatives.E2.layouts.A.blocks[math.constraint]',alsoLayout='C',printedCharacterMaximum=constraint['budget']['characters'][1],lineCount=constraint['budget']['lines'],fontSizeMaximumIncludingTolerancePt=cfont,maxPrintableAdvanceEm=max(advances.values()),maxSupportWidthPt=cmax,targetWidthPt=cwidth,targetHeightPt=constraint['bbox_pt'][3]-constraint['bbox_pt'][1],minimumIoU=.7,maximumIoUUpperBound=cmax/cwidth,conflict=cmax/cwidth<.7,assumptions=bound['assumptions'])
    bound['additionalIndependentConflict']=second
    save(root/'occupied-support-conflict.json',bound)
    baseline=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a4/round-3');manifest=load(baseline/'manifest.json')
    baseline_sha=file_hash(baseline/'manifest.json')
    if baseline_sha!=load(approval)['prototypeManifestSha256']:raise ValueError('prototype manifest differs from approved hash')
    comparison=[dict(id=c['id'],declaredSha256=c['sha256'],actualSha256=file_hash(baseline/c['pdf']),unchanged=file_hash(baseline/c['pdf'])==c['sha256']) for c in manifest['cases']]
    save(root/'prototype-immutability.json',dict(corpusManifestSha256=baseline_sha,cases=comparison,allOriginalPdfHashesUnchanged=all(c['unchanged'] for c in comparison),pilotPdfComparisonAvailable=False,reason='Pilot has not started: strict preflight blocked. These are the 18 original delivered PDF byte hashes, not a regenerated comparison.'))
    misses=[m for r in rows for m in r.get('check',{}).get('misses',[])];ious=[m['detail']['actual'] for m in misses if m['kind']=='block-IoU'];hist=Counter(m['kind'] for m in misses)
    report=freeze(dict(schema='mixed-pdf-pilot-preflight@1',handoffHash=bundle,approvalSha256=file_hash(approval),observedAt=observed,passed=False,stage='blocked before factorial pilot; diagnostics only',pilotPdfs=0,pilotPages=0,checkedAuthoring=rows,blocker=bound,missHistogram=dict(hist),blockIoUDistribution=dict(count=len(ious),minimum=min(ious) if ious else None,quartiles=[float(np.quantile(ious,q)) for q in [.25,.5,.75]] if ious else [],maximum=max(ious) if ious else None),originalCorpusUnchanged=all(c['unchanged'] for c in comparison),validatorCodeSha256={n:file_hash(root/'code'/n) for n in names},acceptance='not assessed; no audit or judge claim'),'reportHash')
    save(root/'preflight-report.json',report)
    save(root/'artifact-hashes.json',freeze(dict(files={str(f.relative_to(root)):dict(sha256=file_hash(f),bytes=f.stat().st_size) for f in sorted(root.rglob('*')) if f.is_file()}),'inventoryHash'))
    print(json.dumps(dict(output=str(root),passed=False,concreteOccupiedSupportConflict=bound)),flush=True)


if __name__=='__main__':main()
