"""Native stage nuisance/visibility proofs. No hard-share corpus generation."""
import argparse
import copy
from collections import Counter
import datetime
from concurrent.futures import ProcessPoolExecutor,as_completed
import traceback
import fitz
import numpy as np
from support import *
from producer import export


def paint_signature(page,authoring,components):
    """Read actual painted text/path/image order, not Writer frame collection order."""
    boxes={b['id']:b['containerPt'] for b in authoring['blocks']}
    regions=[[boxes[bid] for bid in comp] for comp in components]
    first={}
    for seq,(kind,box,*_) in enumerate(page.get_bboxlog()):
        if kind=='ignore-text':continue
        candidates=[i for i,region in enumerate(regions) if any(area(intersect(box,b))>0 for b in region)]
        if not candidates:continue
        # Components have disjoint envelopes; the largest intersection prevents
        # a font diagnostic line box grazing a neighboring region from matching.
        i=max(candidates,key=lambda i:max(area(intersect(box,b)) for b in regions[i]))
        first.setdefault(i,seq)
    assert len(first)==len(components),('Unobserved actual paint components',set(range(len(components)))-set(first))
    return sorted(first,key=first.get)


def compare_pixels(a,b,dpi):
    assert a.rect==b.rect
    pa=a.get_pixmap(dpi=dpi,alpha=False);pb=b.get_pixmap(dpi=dpi,alpha=False)
    aa=np.frombuffer(pa.samples,dtype=np.uint8).reshape(pa.height,pa.width,pa.n)
    bb=np.frombuffer(pb.samples,dtype=np.uint8).reshape(pb.height,pb.width,pb.n)
    return float(np.any(aa!=bb,axis=2).mean()),digest(pa.samples),digest(pb.samples)


def stream_pairs(a,resolved,world,plans,directory,calibration,table_calibration):
    directory=Path(directory);directory.mkdir();results=[]
    # One constructed page per E/layout/producer pairing, derived from frozen
    # authored page 1; both whole producer paths own its complete content.
    original_gold=canonical(a['pages'][0])
    for owner in ['reportlab-full','libreoffice-full']:
        small=copy.deepcopy(a);small['pages']=small['pages'][:1];small['producerPath']=owner
        rr=copy.deepcopy(resolved);rr['pages']=rr['pages'][:1]
        rr['pages'][0]['baselineCalibration']=calibration
        for t in rr['pages'][0]['tables'].values():
            key=f'{t["kind"]}|{t["size"]}|{t["rowHeight"]}|{t["padding"]}';t.update(table_calibration.get(key,{}))
        comps,canonical_order=paint_order(small['pages'][0]['blocks'],a['familyId'],1,False)
        _,permuted_order=paint_order(small['pages'][0]['blocks'],a['familyId'],1,True)
        assert canonical_order!=permuted_order and canonical(small['pages'][0])==original_gold
        out=directory/owner
        first=export(small,rr,world,out,'canonical',orders=[canonical_order]);second=export(small,rr,world,out,'permuted',orders=[permuted_order])
        with fitz.open(first['path']) as x,fitz.open(second['path']) as y:
            changed,hx,hy=compare_pixels(x[0],y[0],150)
            sigx=paint_signature(x[0],small['pages'][0],comps);sigy=paint_signature(y[0],small['pages'][0],comps)
            contentx=''.join(x[0].get_text().split());contenty=''.join(y[0].get_text().split())
            glyphs_equal=Counter(contentx)==Counter(contenty)
            pathsx=Counter((tuple(round(v,3) for v in d['rect']),str(d.get('fill')),str(d.get('color'))) for d in x[0].get_drawings())
            pathsy=Counter((tuple(round(v,3) for v in d['rect']),str(d.get('fill')),str(d.get('color'))) for d in y[0].get_drawings())
            expected_canonical=list(range(len(comps)))
            expected_permuted=sorted(range(len(comps)),key=lambda i:permuted_order.index(next(bid for bid in permuted_order if bid in comps[i])))
            passed=(changed==0 if owner=='reportlab-full' else changed<=.02) and sigx==expected_canonical and sigy==expected_permuted and glyphs_equal and pathsx==pathsy
            x[0].get_pixmap(dpi=150).save(out/'actual-canonical.png');y[0].get_pixmap(dpi=150).save(out/'actual-permuted.png')
            results.append(dict(owner=owner,components=len(comps),actualCanonicalPaintSignature=sigx,actualPermutedPaintSignature=sigy,expectedCanonicalPaintSignature=expected_canonical,expectedPermutedPaintSignature=expected_permuted,changedPixelsFraction=changed,dpi=150,exactGlyphMultisetConserved=glyphs_equal,exactVectorObjectMultisetConserved=pathsx==pathsy,canonicalGoldHash=digest(original_gold),permutedGoldHash=digest(canonical(small['pages'][0])),rasterHashes=[hx,hy],passed=passed))
    result=dict(passed=all(r['passed'] for r in results),pairs=results,observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat());save(directory/'receipt.json',result);return result


def visibility_preflight(a,resolved,world,plans,native,directory):
    """Prove inherited native screenshot/outline encodings without hard cases."""
    directory=Path(directory);directory.mkdir();omit=set();regions=[]
    for page in a['pages']:
        groups=[]
        if a['classId']=='E4' or page['number'] in [2,5,8]:
            blocks=[b for b in page['blocks'] if b['templateId'].startswith('discussion.')]
            frame=next(b['containerPt'] for b in blocks if b['templateId']=='discussion.frame')
            groups.append(dict(kind='whole-panel-screenshot',bbox=frame,blockIds=[b['id'] for b in blocks]))
        if page['number'] in [4,9]:
            for b in page['blocks']:
                if b['templateId'] in ['body.1','body.2']:groups.append(dict(kind='outlined-body',bbox=b['containerPt'],blockIds=[b['id']]))
        omit.update(bid for group in groups for bid in group['blockIds']);regions.append(groups)
    transform_plan=freeze(dict(schema='a5-native-visibility-probe@1',authoringHash=a['authoringHash'],nativeHash=digest(Path(native).read_bytes()),regions=regions,omittedBlockIds=sorted(omit)),'planHash')
    save(directory/'frozen-probe-plan.json',transform_plan)
    proof=export(a,resolved,world,directory,'remaining',omit=omit);save(directory/'remaining-producer-proof.json',proof)
    outlined=directory/'outlined-source.pdf'
    from outlines import outline_bodies
    outline_bodies(a,native,outlined)
    expected_omitted=Counter(g['text'] for page in a['pages'] for b in page['blocks'] if b['id'] in omit for g in b['glyphs'] if not g['text'].isspace())
    results=[];misses=[]
    with fitz.open(native) as src,fitz.open(proof['path']) as dst,fitz.open(outlined) as outlines:
        assert not any(p.get_text().strip() for p in outlines),'NoOutputFonts left native text in outlined source'
        for i,(sp,dp,groups) in enumerate(zip(src,dst,regions)):
            expected_remaining=Counter(g['text'] for b in a['pages'][i]['blocks'] if b['id'] not in omit for g in b['glyphs'] if not g['text'].isspace())
            actual_remaining=Counter(c for c in dp.get_text() if not c.isspace())
            if expected_remaining!=actual_remaining:misses.append(dict(page=a['pages'][i]['id'],kind='native omission glyph leakage/loss',missing=dict(expected_remaining-actual_remaining),extra=dict(actual_remaining-expected_remaining)))
            for j,group in enumerate(groups):
                rect=fitz.Rect(group['bbox'])
                if group['kind']=='outlined-body':
                    dp.show_pdf_page(rect,outlines,i,clip=rect,keep_proportion=False)
                else:
                    image=sp.get_pixmap(dpi=150,clip=rect,alpha=False)
                    image_path=directory/f'{a["pages"][i]["id"]}-panel-{j}.png';image.save(image_path)
                    dp.insert_image(rect,stream=image.tobytes('png'))
                # Image/path placement is a fresh native probe; labels remain
                # frozen and never get regenerated from this rendered output.
            changed,ha,hb=compare_pixels(sp,dp,300)
            if changed>.02:misses.append(dict(page=a['pages'][i]['id'],kind='native visibility raster delta',actual=changed))
            results.append(dict(pageId=a['pages'][i]['id'],groups=groups,changedPixelsFraction=changed,dpi=300,originalRenderHash=ha,probeRenderHash=hb))
            if i in [1,3,7]:dp.get_pixmap(dpi=150).save(directory/f'actual-probe-p{i+1:02d}.png')
        dst.set_metadata({**dst.metadata,'producer':'PyMuPDF '+fitz.VersionBind,'creator':'Native visibility preflight'})
        dst.save(directory/'native-visibility.pdf')
    result=dict(passed=not misses,misses=misses,pages=results,source='actual full native exports and independent omitted export; no final corpus case',planHash=transform_plan['planHash']);save(directory/'receipt.json',result);return result


def one_family(task):
    fid,root=task;root=Path(root)
    cal=json.loads((root/'constructed-baseline-calibration.json').read_text())['calibration'];tcal=json.loads((root/'constructed-table-calibration.json').read_text())['calibration']
    try:
        p=root/f'f{fid:04d}';os.environ['MPLCONFIGDIR']=str(p/'extras-mpl-cache')
        a=json.loads((p/'authoring.json').read_text());r=json.loads((p/'source-layout.json').read_text());w=json.loads((p/'world.json').read_text());plans=[json.loads(f.read_text()) for f in sorted((p/'support-plans').glob('*.json'))]
        for page in r['pages']:
            page['baselineCalibration']=cal
            for t in page['tables'].values():t.update(tcal.get(f'{t["kind"]}|{t["size"]}|{t["rowHeight"]}|{t["padding"]}',{}))
        pair=json.loads((p/'stream-pairs/receipt.json').read_text()) if (p/'stream-pairs/receipt.json').exists() else stream_pairs(a,r,w,plans,p/'stream-pairs',cal,tcal)
        visibility=json.loads((p/'visibility-preflight/receipt.json').read_text()) if (p/'visibility-preflight/receipt.json').exists() else visibility_preflight(a,r,w,plans,p/'native.pdf',p/'visibility-preflight')
        result=dict(familyId=fid,streamPairsPassed=pair['passed'],nativeVisibilityPassed=visibility['passed']);print(result,flush=True);return result
    except Exception as error:
        save(root/f'f{fid:04d}/extra-native-gates-failure.txt',traceback.format_exc())
        return dict(familyId=fid,streamPairsPassed=False,nativeVisibilityPassed=False,error=repr(error))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('round_dir',type=Path);parser.add_argument('--families',type=int,nargs='*');parser.add_argument('--workers',type=int,choices=[1,2,3],default=3);args=parser.parse_args();root=args.round_dir
    save(root/'extra-gate-builder-source/extras.py',Path(__file__).read_bytes())
    tasks=[(fid,str(root)) for fid in args.families or [i for i in range(1,18) if i not in (6,12)]]
    results=[]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for f in as_completed([pool.submit(one_family,t) for t in tasks]):results.append(f.result())
    results.sort(key=lambda r:r['familyId'])
    save(root/'extra-native-gates-complete.json',dict(results=results,passed=all(r['streamPairsPassed'] and r['nativeVisibilityPassed'] for r in results)))


if __name__=='__main__':main()
