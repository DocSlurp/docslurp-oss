"""Actual embedded-font, paint-order and 300-DPI ink checks on every page."""
from __future__ import annotations
from collections import defaultdict
from pathlib import Path
import math
import numpy as np
import pymupdf as fitz
from contract import union, iou, contains, intersect, area, digest, save, SPEC
from native_geometry import native_glyphs


def inspect_pdf(authoring,plans,scenes,pdf,images):
    misses=[];pages=[];images=Path(images);images.mkdir(parents=True,exist_ok=True)
    with fitz.open(pdf) as doc:
        if len(doc)!=10:return dict(passed=False,misses=[dict(kind='complete-ten-page-count',actual=len(doc))])
        for page,ap,plan,scene in zip(doc,authoring['pages'],plans,scenes):
            pr=dict(pageId=ap['id'],glyphsChecked=0,leavesChecked=0,primitivesChecked=0,minLeafIou=1.0)
            try:
                actual,fonts=native_glyphs(doc,page);pr['embeddedFontHashes']=fonts
                by_text=defaultdict(list)
                for i,g in enumerate(actual):by_text[g['text']].append(i)
                used=set();matched={};hidden=[]
                pix=page.get_pixmap(dpi=300,alpha=False)
                rgb=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,pix.n)[...,:3]
                drawings=page.get_drawings()
                fills=[d for d in drawings if d.get('fill') is not None and d.get('fill_opacity',1)==1]
                for leaf in plan['leaves']:
                    found=[]
                    for expected in leaf['glyphs']:
                        if expected['expectedInkPt'] is None:continue
                        x,y=expected['baselinePt'];choices=[i for i in by_text[expected['text']] if i not in used]
                        assert choices,('Missing native expected glyph',leaf['id'],expected['id'],expected['text'])
                        chosen=min(choices,key=lambda i:math.dist(actual[i]['origin'],[x,y]))
                        glyph=actual[chosen];distance=math.dist(glyph['origin'],[x,y])
                        assert distance<=2,('Glyph anchor exceeds 2 pt',expected['id'],distance,glyph['origin'],[x,y])
                        assert abs(glyph['size']-expected['sizePt'])<=.3,('Native glyph font size',expected['id'],glyph['size'])
                        used.add(chosen);found.append(glyph['ink']);matched[expected['id']]=glyph
                        if leaf['visible']:
                            ink=glyph['ink'];x0,y0,x1,y1=ink
                            crop=rgb[max(0,math.floor(y0*300/72)):min(pix.height,math.ceil(y1*300/72)),max(0,math.floor(x0*300/72)):min(pix.width,math.ceil(x1*300/72))]
                            target=np.array(glyph['color'])*255
                            hit=np.linalg.norm(crop.astype(float)-target,axis=2)<60
                            assert np.count_nonzero(hit)>=1,('Native glyph has no rendered ink',expected['id'])
                            for d in fills:
                                if d['seqno']>glyph['seqno'] and contains(list(d['rect']),ink):
                                    raise AssertionError(('Meaningful glyph covered by later opaque paint',expected['id'],d['seqno']))
                        else:hidden.append((expected,glyph))
                        pr['glyphsChecked']+=1
                    if found:
                        score=iou(union(found),leaf['expectedSupportPt'])
                        # Formula leaves include mathematical strokes; add independently read paths below.
                        if leaf['primitivePaths']:
                            import json
                            found += [[min(p[0],p[2])-.25,min(p[1],p[3])-.25,max(p[0],p[2])+.25,max(p[1],p[3])+.25] for p in map(json.loads,leaf['primitivePaths'])]
                            score=iou(union(found),leaf['expectedSupportPt'])
                        assert score>=.7,('Leaf occupied-support IoU',leaf['id'],score)
                        pr['minLeafIou']=min(pr['minLeafIou'],score);pr['leavesChecked']+=1
                assert len(used)==len(actual),('Unexpected native glyphs',len(actual)-len(used),[actual[i]['text'] for i in range(len(actual)) if i not in used][:40])
                # Real stroke geometry and final rendered centerline evidence, independently of labels.
                segments=[]
                for d in drawings:
                    for item in d['items']:
                        if item[0]=='l':segments.append((list(item[1]),list(item[2]),d))
                for bid,real in scene['resolved'].items():
                    for line in real['paths']:
                        a,b=line[:2],line[2:]
                        candidates=[(p,q,d) for p,q,d in segments if min(math.dist(a,p)+math.dist(b,q),math.dist(a,q)+math.dist(b,p))<=1.0]
                        assert candidates,('Missing native mathematical/chart segment',bid,line)
                        xs=np.linspace(a[0],b[0],41);ys=np.linspace(a[1],b[1],41);visible=0
                        for x,y in zip(xs,ys):
                            xx=round(x*300/72);yy=round(y*300/72)
                            crop=rgb[max(0,yy-2):yy+3,max(0,xx-2):xx+3]
                            if np.any(np.min(crop,axis=2)<170):visible+=1
                        assert visible>=39,('Mathematical/chart segment lacks complete rendered ink',bid,line,visible)
                        pr['primitivesChecked']+=1
                if authoring['classId']=='E5':
                    cover=next(b for b in ap['blocks'] if b['templateId']=='overlay.cover')['containerPt']
                    for expected,g in hidden:
                        ink=g['ink'];assert contains([cover[0]+1,cover[1]+1,cover[2]-1,cover[3]-1],ink),'Hidden glyph lacks 1 pt safety'
                        x=round((ink[0]+ink[2])/2*300/72);y=round((ink[1]+ink[3])/2*300/72)
                        assert np.max(np.abs(rgb[y,x].astype(int)-np.array([.88,.89,.9])*255))<=2,'Wrong opaque cover paint'
                # Representative full pages and difficult crops are evidence, not an aggregate gate.
                if ap['number'] in (1,10):
                    page.get_pixmap(dpi=150).save(images/(ap['id']+'.png'))
                    page.get_pixmap(dpi=300,clip=fitz.Rect(30,285,580,705)).save(images/(ap['id']+'.technical.png'))
                pr['passed']=True
            except Exception as e:
                pr['passed']=False;pr['error']=str(e)
                misses.append(dict(pageId=ap['id'],kind='native-or-rendered-support',detail=str(e)))
                page.get_pixmap(dpi=150).save(images/(ap['id']+'.failed.png'))
            pages.append(pr)
    return dict(passed=not misses,pages=pages,misses=misses,pdfHash=digest(Path(pdf).read_bytes()),
        observation='Every page independently inspected; 300 DPI native glyph/stroke visibility; no output-fitted targets')


def compare_pair(canonical,permuted):
    pages=[]
    with fitz.open(canonical) as a,fitz.open(permuted) as b:
        assert len(a)==len(b)==10
        for p,q in zip(a,b):
            x=p.get_pixmap(dpi=150,alpha=False);y=q.get_pixmap(dpi=150,alpha=False)
            xa=np.frombuffer(x.samples,dtype=np.uint8);ya=np.frombuffer(y.samples,dtype=np.uint8)
            changed=float(np.mean(np.any(xa.reshape(-1,x.n)!=ya.reshape(-1,y.n),axis=1)))
            pages.append(dict(page=p.number+1,changedPixelFraction=changed,exact=changed==0,withinTwoPercent=changed<=.02))
    return dict(passed=all(p['withinTwoPercent'] for p in pages),pages=pages)
