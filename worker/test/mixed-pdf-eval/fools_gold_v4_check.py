#!/usr/bin/env python3
"""Independent v4 structural/render checks. No extraction quality score.

Only this build's frozen authoring and actual PDFs are read. No source corpus,
prior build, source file path or audit storage is accessed by this program.
"""
import argparse
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
import json
from pathlib import Path
import re
import sys

import fitz
import numpy as np
import pikepdf
from fontTools.ttLib import TTFont

from fools_gold_v4_common import *


def issue(kind,location,detail):return dict(kind=kind,location=location,detail=detail)


def evaluate_ast(ast,variables):
    op=ast['op']
    if op=='symbol':return Decimal(variables[ast['name']])
    if op=='constant':return Decimal(ast['valueDecimal'])
    args=[evaluate_ast(a,variables) for a in ast['args']]
    if op in ['equal','interval','and','tolerance']:return args
    if op=='add' or op=='sum':return sum(args,Decimal(0))
    if op=='multiply':
        v=Decimal(1)
        for a in args:v*=a
        return v
    if op=='subtract':return args[0]-args[1]
    if op=='divide':
        if args[1]==0:raise ValueError('zero denominator')
        return args[0]/args[1]
    if op=='power':return args[0]**args[1]
    raise ValueError(op)


def authoring_checks(spec,family,record,world):
    misses=[];layout=layout_for(spec,family);templates={t['id']:t for t in layout['blocks']};seen=set();glyphids=set()
    if record_hash(record,'authoringHash')!=record['authoringHash']:misses.append(issue('hash','authoring','self hash differs'))
    if record_hash(world,'worldHash')!=world['worldHash'] or record['worldHash']!=world['worldHash']:misses.append(issue('hash','world','self/reference hash differs'))
    if record['split']!=('train' if family['familyId']<54 else 'tune' if family['familyId']<72 else 'heldout'):misses.append(issue('split','family','invalid split'))
    for page in record['pages']:
        lookup={b['id']:b for b in page['blocks']};order=page['readingOrder']
        expected=[b['id'] for b in sorted(page['blocks'],key=lambda b:b['readingRank'] if b['readingRank'] is not None else 10000) if b['visible'] and b['displayText']]
        if order!=expected:misses.append(issue('reading-order',page['id'],dict(actual=order,expected=expected)))
        if len(order)!=len(set(order)):misses.append(issue('duplicates',page['id'],'duplicate block reference'))
        for name,ids in [('sections','blockIdsForSections'),('paragraphs','blockIdsForParagraphs')]:
            if page[ids]!=order or page[name]!=[lookup[i]['displayText'] for i in order]:misses.append(issue('canonical-projection',page['id'],name))
        if page['expectedMarkdown']!='\n\n'.join(lookup[i]['displayText'] for i in order):misses.append(issue('canonical-projection',page['id'],'Markdown differs'))
        total=sum(len(words(b['displayText'])) for b in page['blocks'] if b['templateId'] in ['body.1','body.2'])
        low,high=layout['body_words_total']['allowed']
        if not low<=total<=high:misses.append(issue('body-total',page['id'],dict(actual=total,allowed=[low,high])))
        for b in page['blocks']:
            if b['id'] in seen:misses.append(issue('duplicate-id',b['id'],'block ID duplicated'))
            seen.add(b['id']);t=templates.get(b['templateId'])
            if not contains([0,0,612,792],b['bboxPt']):misses.append(issue('page-overflow',b['id'],b['bboxPt']))
            for a,z in zip(normalized(b['bboxPt']),b['bboxNormalized']):
                if abs(a-z)*792>.001:misses.append(issue('normalized-box',b['id'],'roundtrip exceeds 0.001 pt'))
            if t:
                wc=len(words(b['displayText']));cc=len(norm(b['displayText']));bb=t['budget']
                lc=0 if b['chart'] else len(b['displayText'].splitlines()) if b['displayText'] else 0
                for kind,value in [('words',wc),('characters',cc),('lines',lc)]:
                    lo,hi=bb[kind]
                    if not lo<=value<=hi:misses.append(issue('budget',b['id'],dict(kind=kind,actual=value,allowed=[lo,hi])))
                measured=iou(b['bboxPt'],t['bbox_pt'])
                if measured<.7:misses.append(issue('block-IoU',b['id'],dict(actual=measured,minimum=.7,box=b['bboxPt'],target=t['bbox_pt'])))
                if not contains(t['container_pt'],b['bboxPt']):misses.append(issue('container-overflow',b['id'],dict(box=b['bboxPt'],container=t['container_pt'])))
            for g in b['glyphs']:
                if g['id'] in glyphids:misses.append(issue('glyph-sharing',g['id'],'duplicated glyph'))
                glyphids.add(g['id'])
                if g['blockId']!=b['id'] or g['visible']!=b['visible']:misses.append(issue('glyph-binding',g['id'],'owner/visibility differs'))
                if g['logicalOffset']>=len(b['displayText']) or b['displayText'][g['logicalOffset']]!=g['text']:misses.append(issue('logical-offset',g['id'],'glyph does not resolve to displayText'))
                if not contains([0,0,612,792],g['bboxPt']) or area(g['bboxPt'])<=0:misses.append(issue('glyph-overflow',g['id'],g['bboxPt']))
            if b['cells']:
                shape=t.get('table_shape',{});rows=shape.get('rows',max(c['row']+c['rowSpan'] for c in b['cells']));cols=shape.get('columns',4);grid=Counter()
                if len(b['cells'])!=shape.get('semantic_cell_count',len(b['cells'])):misses.append(issue('table-cell-count',b['id'],len(b['cells'])))
                for c in b['cells']:
                    for r in range(c['row'],c['row']+c['rowSpan']):
                        for col in range(c['column'],c['column']+c['columnSpan']):grid[(r,col)]+=1
                    if not contains(b['containerPt'],c['bboxPt']):misses.append(issue('cell-containment',b['id'],[c['row'],c['column']]))
                    cg={g['id']:g for g in b['glyphs']}
                    if ''.join(cg[i]['text'] for i in c['glyphIds'])!=c['displayText']:misses.append(issue('cell-text',b['id'],[c['row'],c['column']]))
                if grid!=Counter({(r,c):1 for r in range(rows) for c in range(cols)}):misses.append(issue('table-grid',b['id'],'spans not complete/nonoverlapping'))
                if family['classId']=='P':
                    if b['displayText'].count('|')!=15:misses.append(issue('table-separators',b['id'],'not 15 pipes'))
                    for r in range(1,5):
                        cs=[next(c for c in b['cells'] if c['row']==r and c['column']==j) for j in range(4)]
                        ratio=(Decimal(cs[2]['displayText'])/Decimal(cs[1]['displayText'])).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
                        if ratio!=Decimal(cs[3]['displayText']):misses.append(issue('numeric-table',b['id'],r))
                        for j,c in enumerate(cs):
                            lo,hi=shape['data_character_ranges'][j]
                            if not lo<=len(c['displayText'])<=hi:misses.append(issue('table-cell-budget',b['id'],[r,j,c['displayText']]))
            f=b['formula']
            if f:
                if f['display']!=b['displayText']:misses.append(issue('formula-display',b['id'],'literal mismatch'))
                variables={v['symbol']:v['valueDecimal'] for v in f['variables']}
                try:
                    value=evaluate_ast(f['ast'],variables)
                    if f['ast']['op']=='equal':
                        target=Decimal(f['valueDecimal']);actual=value[1].quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
                        if actual!=target or value[0]!=target:misses.append(issue('formula-value',b['id'],dict(actual=str(actual),expected=str(target))))
                        for symbol in variables:
                            if symbol.replace('_','') not in f['display'] and symbol not in f['display']:misses.append(issue('formula-symbol',b['id'],symbol))
                        if family['classId']=='P':
                            rhs=f['ast']['args'][1]
                            if rhs['op']!='divide' or any(a['op']!='symbol' for a in rhs['args']):misses.append(issue('formula-shape',b['id'],'prototype is not symbolic quotient'))
                    if f['ast']['op']=='and':
                        bounds=value[0];tol=value[1][0]
                        if not(bounds[0]<bounds[1] and tol>0 and '+/-' in f['display']):misses.append(issue('formula-constraint',b['id'],'invalid interval/tolerance'))
                except Exception as exc:misses.append(issue('formula-evaluation',b['id'],str(exc)))
        # Semantic region support is independently checked, not just leaf mean.
        for gid,suffixes in layout['semantic_regions'].items():
            actual=union_box(lookup[page['id']+'.'+s]['bboxPt'] for s in suffixes)
            target=union_box(templates[s]['bbox_pt'] for s in suffixes)
            if iou(actual,target)<.7:misses.append(issue('parent-IoU',page['id']+'.'+gid,iou(actual,target)))
    diversity=diversity_report(record)
    if not diversity['passed']:misses.append(issue('content-diversity',record['familyId'],diversity))
    return dict(passed=not misses,misses=misses,diversity=diversity,checkedPages=len(record['pages']),selfScore=None)


def actual_glyphs(doc,page):
    """Actual native positions and embedded font metrics, independent of gold.

    MuPDF normalizes texttrace rectangles to em-height; the measured handoff
    asks for occupied typographic support. Recover that from each actual font
    program's hhea metrics and the actual native text origins, without using
    authored geometry or enlarging rectangles to source target containers.
    """
    metrics={}
    for f in page.get_fonts(full=True):
        xref,ext,kind,name,resource,*_=f
        raw=doc.extract_font(xref)[3]
        if raw:
            font=TTFont(BytesIO(raw));up=font['head'].unitsPerEm
            metrics[name.split('+')[-1]]=(font['hhea'].ascent/up,font['hhea'].descent/up)
    chars=[]
    for span in page.get_texttrace():
        if span.get('type',0)==3:continue
        font=span['font'].replace(' ','');key=font.split('+')[-1]
        metric=metrics.get(key)
        if metric is None:
            metric=next((v for k,v in metrics.items() if k.replace('-','')==key.replace('-','')),None)
        if metric is None:raise ValueError('No embedded font metrics for '+key)
        asc,desc=metric;size=span['size']
        for char in span['chars']:
            cp,gid,origin,box=char
            if chr(cp).isspace():continue
            chars.append(dict(text=chr(cp),origin=list(origin),size=size,
                              bboxPt=[origin[0],origin[1]-asc*size,box[2],origin[1]-desc*size],font=font))
    return chars


def compare_native(authoring,pdf,omitted=None,spec=None,family=None):
    misses=[];pages=[]
    with fitz.open(pdf) as doc:
        if len(doc)!=10:misses.append(issue('native-page-count',str(pdf),len(doc)))
        for page,gold in zip(doc,authoring['pages']):
            actual=actual_glyphs(doc,page);used=set();byblock={};missing=[]
            for block in gold['blocks']:
                if omitted and block['id'] in omitted:continue
                if block['assetHash'] and (block['formula'] or block['chart']):continue
                for g in block['glyphs']:
                    if g['text'].isspace():continue
                    size=block['fonts'][0]['sizePt'];asc={'Liberation Sans':.9052734375,'Liberation Mono':.83251953125}[block['fonts'][0]['family']]
                    origin=[g['bboxPt'][0],g['bboxPt'][1]+asc*size]
                    candidates=[(math_dist(a['origin'],origin),j) for j,a in enumerate(actual) if j not in used and a['text']==g['text']]
                    distance,j=min(candidates,default=(float('inf'),None))
                    if distance>2:
                        missing.append(dict(id=g['id'],text=g['text'],distance=distance if j is not None else None));continue
                    used.add(j);byblock.setdefault(block['id'],[]).append(actual[j]['bboxPt'])
            extra=[a for j,a in enumerate(actual) if j not in used]
            if missing:misses.append(issue('native-missing-glyph',gold['id'],missing[:15]))
            if extra:misses.append(issue('native-extra-glyph',gold['id'],extra[:15]))
            measured={bid:union_box(boxes) for bid,boxes in byblock.items()}
            if spec and family:
                layout=layout_for(spec,family);templates={t['id']:t for t in layout['blocks']}
                for b in gold['blocks']:
                    if omitted and b['id'] in omitted:continue
                    t=templates.get(b['templateId'])
                    if t is None:continue
                    if b['id'] in measured:
                        score=iou(measured[b['id']],t['bbox_pt'])
                        if score<.7:misses.append(issue('actual-native-IoU',b['id'],dict(actual=score,box=measured[b['id']],target=t['bbox_pt'])))
                    if b['role'] in ['panel-background','decoration','occluder']:
                        color=(.93,.95,.965) if b['role']=='panel-background' else (.48,.59,.66) if b['role']=='decoration' else (1,1,1)
                        matches=[d for d in page.get_drawings() if d.get('fill') and max(abs(x-y) for x,y in zip(d['fill'],color))<.005]
                        if len(matches)!=1:misses.append(issue('actual-native-physical',b['id'],dict(expectedOneColorBoundObject=color,actual=len(matches))))
                        elif iou(list(matches[0]['rect']),t['bbox_pt'])<.7:misses.append(issue('actual-native-physical-IoU',b['id'],dict(box=list(matches[0]['rect']),target=t['bbox_pt'])))
            pages.append(dict(pageId=gold['id'],actualGlyphCount=len(actual),matchedGlyphCount=len(used),missingGlyphCount=len(missing),extraGlyphCount=len(extra),blockSupport=measured))
    return dict(passed=not misses,misses=misses,pages=pages,method='actual text origins + actual embedded font hhea support',selfScore=None)


def math_dist(a,b):return ((a[0]-b[0])**2+(a[1]-b[1])**2)**.5


def render_diff(before,after,report_dir,dpi=150,threshold=0):
    """Every changed pixel is counted; no broadened threshold or tolerance."""
    Path(report_dir).mkdir(parents=True,exist_ok=True);rows=[]
    with fitz.open(before) as left,fitz.open(after) as right:
        if len(left)!=len(right):return dict(passed=False,misses=['page count differs'])
        for i,(a,b) in enumerate(zip(left,right)):
            a.set_rotation(0);b.set_rotation(0)
            pa=a.get_pixmap(dpi=dpi,alpha=False);pb=b.get_pixmap(dpi=dpi,alpha=False)
            aa=np.frombuffer(pa.samples,np.uint8).reshape(pa.height,pa.width,pa.n)
            bb=np.frombuffer(pb.samples,np.uint8).reshape(pb.height,pb.width,pb.n)
            if aa.shape!=bb.shape:rows.append(dict(page=i+1,changedFraction=1,passed=False));continue
            changed=np.any(np.abs(aa.astype(np.int16)-bb.astype(np.int16))>threshold,axis=2)
            fraction=float(np.mean(changed));rows.append(dict(page=i+1,changedPixels=int(changed.sum()),pixels=int(changed.size),changedFraction=fraction,passed=fraction<=.02))
            if fraction>0:
                from PIL import Image
                Image.fromarray(np.where(changed[:,:,None],np.array([220,30,50]),(aa*.45+140).astype(np.uint8)).astype(np.uint8)).save(Path(report_dir)/f'p{i+1:02d}-diff.png')
    return dict(passed=all(r['passed'] for r in rows),dpi=dpi,channelDifferenceThreshold=threshold,maximumChangedPixelFraction=.02,pages=rows)


def pdf_profile(pdf):
    with fitz.open(pdf) as doc, pikepdf.open(pdf) as p:
        fonts=set();images={};content=fontbytes=0;pages=[];unembedded=[]
        for i,page in enumerate(doc):
            for xref,*_ in page.get_fonts(full=True):
                if xref not in fonts:
                    rawfont=doc.extract_font(xref)[3];fontbytes+=len(rawfont);fonts.add(xref)
                    if not rawfont:unembedded.append(xref)
            pageimages=[]
            for im in page.get_image_info(xrefs=True):
                xref=im['xref'];data=doc.extract_image(xref) if xref else {}
                encoded=len(doc.xref_stream_raw(xref) or b'') if xref else 0;decoded=im['width']*im['height']*im['colorspace']
                if xref:images[xref]=(encoded,decoded)
                box=list(im['bbox']);pageimages.append(dict(xref=xref,box=box,pixels=[im['width'],im['height']],encodedBytes=encoded,decodedBytes=decoded,ppi=[im['width']*72/(box[2]-box[0]),im['height']*72/(box[3]-box[1])]))
            content+=sum(len(doc.xref_stream(x) or b'') for x in page.get_contents())
            pages.append(dict(page=i+1,images=pageimages,paths=len(page.get_drawings()),nativeGlyphs=sum(len(s['chars']) for s in page.get_texttrace()),annotations=sum(1 for _ in (page.annots() or [])),rotation=page.rotation,displaySize=[page.rect.width,page.rect.height]))
        xrefstreams=sum(1 for obj in p.objects if isinstance(obj,pikepdf.Stream) and obj.get('/Type')==pikepdf.Name('/XRef'))
        objectstreams=sum(1 for obj in p.objects if isinstance(obj,pikepdf.Stream) and obj.get('/Type')==pikepdf.Name('/ObjStm'))
        raw=Path(pdf).read_bytes();xref_bytes=0
        for match in re.finditer(rb'(?m)^xref\r?\n',raw):
            end=raw.find(b'trailer',match.start())
            if end>=0:xref_bytes+=end-match.start()
        for obj in p.objects:
            if isinstance(obj,pikepdf.Stream) and obj.get('/Type')==pikepdf.Name('/XRef'):xref_bytes+=len(obj.read_raw_bytes())
        return dict(pdfVersion=p.pdf_version,linearized=p.is_linearized,encrypted=p.is_encrypted,xrefBytes=xref_bytes,
                    info={str(k):str(v) for k,v in p.docinfo.items()},fileBytes=Path(pdf).stat().st_size,
                    bytesPerPage=Path(pdf).stat().st_size/len(doc),pageCount=len(doc),objectCount=len(p.objects),
                    xrefCount=doc.xref_length(),xrefStreamCount=xrefstreams,objectStreamCount=objectstreams,
                    encodedImageBytes=sum(v[0] for v in images.values()),decodedImageBytes=sum(v[1] for v in images.values()),
                    fontProgramBytes=fontbytes,unembeddedFontXrefs=unembedded,decodedContentStreamBytes=content,pages=pages)


def operator_scan(pdf,page_number):
    """Recursive native leakage check, including nested Form XObjects."""
    with pikepdf.open(pdf) as doc:
        page=doc.pages[page_number];visited=set();counts=Counter();images=[]
        def walk(obj,res):
            for operands,operator in pikepdf.parse_content_stream(obj):
                op=str(operator);counts[op]+=1
                if op=='Do':
                    target=res.get('/XObject',{}).get(operands[0])
                    if target is None:continue
                    if target.get('/Subtype')==pikepdf.Name('/Form'):
                        counts['Form']+=1;oid=target.objgen
                        if oid not in visited:visited.add(oid);walk(target,target.get('/Resources',res))
                    elif target.get('/Subtype')==pikepdf.Name('/Image'):images.append(target.objgen)
        walk(page,page.get('/Resources',{}))
        return dict(operators=dict(counts),textShowOperators=sum(counts[x] for x in ['Tj','TJ',"'",'"']),formCount=counts['Form'],imagePaintCount=len(images),annotations=len(page.get('/Annots',[])))


def check_corpus(root,spec):
    root=Path(root);manifest=load(root/'manifest.json');misses=[];counts=Counter();cases=[]
    for case in manifest['cases']:
        counts['pdfs']+=1
        for path,key in [(case['pdf'],'sha256'),(case['labels'],'labelHash')]:
            if file_hash(root/path)!=case[key]:misses.append(issue('file-hash',path,'raw bytes differ'))
        pdf=root/case['pdf'];profile=pdf_profile(pdf);counts['pages']+=profile['pageCount']
        expected=spec['file_profile']['case_storage_profiles']['profiles'][(case['hardPercent']//20+case['familyId'])%6]
        if profile['pdfVersion']!=str(expected['version']) or profile['linearized']!=expected['linearized'] or bool(profile['objectStreamCount'])!=expected['object_streams'] or bool(profile['xrefStreamCount'])!=(expected['xref']=='stream'):misses.append(issue('storage-profile',case['id'],dict(expected=expected,actual={k:profile[k] for k in ['pdfVersion','linearized','objectStreamCount','xrefStreamCount']})))
        if profile['encrypted'] or profile['unembeddedFontXrefs']:misses.append(issue('font-or-encryption',case['id'],dict(encrypted=profile['encrypted'],unembedded=profile['unembeddedFontXrefs'])))
        family=f'{case["familyId"]:04d}';a=load(root/f'sources/{family}/authoring.json');plan=load(root/f'plans/{family}/{case["hardPercent"]}.json');execution=load(root/f'executions/{family}/{case["hardPercent"]}.json');ep=load(root/f'plans/{family}/{case["hardPercent"]}-exclusions.json');ee=load(root/f'executions/{family}/{case["hardPercent"]}-exclusions.json');label=load(root/case['labels'])
        for name,record,selfkey in [('authoring',a,'authoringHash'),('transform_plan',plan,'planHash'),('transform',execution,'executionHash'),('exclusion_plan',ep,'exclusionPlanHash'),('exclusions',ee,'exclusionsHash')]:
            try:validate_schema(record,spec['immutable_records']['schemas'][name])
            except Exception as exc:misses.append(issue('schema',case['id']+'/'+name,str(exc)))
            if record_hash(record,selfkey)!=record[selfkey]:misses.append(issue('record-hash',case['id']+'/'+name,'self hash differs'))
        hp=case['hardPercent'];hard=set(plan['selectedHardPageIds'])
        if plan['selectedHardPageIds']!=plan['hardPageRank'][:hp//10]:misses.append(issue('hard-prefix',case['id'],'not exact prefix'))
        for key in ['authoringHash','planHash','exclusionPlanHash','exclusionsHash']:
            references={'authoringHash':a['authoringHash'],'planHash':plan['planHash'],'exclusionPlanHash':ep['exclusionPlanHash'],'exclusionsHash':ee['exclusionsHash']}
            if case[key]!=references[key]:misses.append(issue('manifest-reference',case['id'],key))
        if execution['outputPdfHash']!=file_hash(pdf) or label['executionHash']!=execution['executionHash']:misses.append(issue('execution-binding',case['id'],'PDF/label execution hash differs'))
        if ee['exclusionPlanHash']!=ep['exclusionPlanHash'] or ee['planHash']!=plan['planHash']:misses.append(issue('exclusion-binding',case['id'],'exclusion plan references differ'))
        for item in ep['items']:
            page=next(p for p in a['pages'] if p['id']==item['pageId']);lookup={b['id']:b for b in page['blocks']};b=lookup[item['blockId']]
            if b['semanticClass']!='decoy' or b['visible'] or sha(b['displayText'].encode())!=item['authoredDisplayTextHash'] or item['glyphIds']!=[g['id'] for g in b['glyphs']]:misses.append(issue('exclusion-authoring',b['id'],'not a preexisting bound decoy'))
            covers=[lookup[i] for i in item['occluderBlockIds']]
            for g in b['glyphs']:
                if not any(c['zOrder']>b['zOrder'] and contains(c['bboxPt'],g['bboxPt']) for c in covers):misses.append(issue('exclusion-cover',g['id'],'glyph not wholly under higher opaque cover'))
            for visible in page['blocks']:
                if not visible['visible'] or not visible['glyphs']:continue
                if any(area(intersection(c['bboxPt'],g['bboxPt']))>0 for c in covers for g in visible['glyphs']):misses.append(issue('cover-touches-content',visible['id'],'occluder overlaps meaningful glyph'))
        for i,p in enumerate(plan['pages']):
            ops=operator_scan(pdf,i)
            if p['hardScan'] and not(ops['textShowOperators']==0 and ops['formCount']==0 and ops['imagePaintCount']==1 and ops['annotations']==0):misses.append(issue('hard-isolation',p['pageId'],ops))
            if p['hardScan']!=(p['pageId'] in hard):misses.append(issue('hard-binding',p['pageId'],'selection differs'))
            if not p['hardScan'] and len(p['selectedSectionGroups'])!=round(case['sectionRasterShare']*5):misses.append(issue('section-cardinality',p['pageId'],'wrong exact group count'))
            pg=a['pages'][i];glookup={g['id']:g for b in pg['blocks'] for g in b['glyphs']};transforms=label['pages'][i]['glyphTransforms'];ids=[g['id'] for g in transforms]
            if len(ids)!=len(set(ids)) or set(ids)!=set(glookup):misses.append(issue('label-glyph-union',p['pageId'],'missing, extra or duplicated glyph IDs'))
            for g in transforms:
                original=glookup[g['id']]
                if g['text']!=original['text'] or g['visible']!=original['visible']:misses.append(issue('label-glyph-binding',g['id'],'text/visibility differs'))
                box=g['displayBboxPt'];size=p['outputPageSizePt']
                if not contains([0,0,*size],box):misses.append(issue('label-glyph-overflow',g['id'],box))
                if max(abs(a-b)*max(size) for a,b in zip(normalized(box,size),g['displayBboxNormalized']))>.001:misses.append(issue('label-normalization',g['id'],'roundtrip > 0.001 pt'))
            prev=plan['basePdfHash'];result=execution['pages'][i]
            for planned,measured in zip(p['operations'],result['operations']):
                if any(measured[k]!=v for k,v in planned.items()):misses.append(issue('execution-parameters',planned['id'],'execution changed frozen plan'))
                if measured['inputStageHash']!=prev:misses.append(issue('execution-chain',planned['id'],'previous stage hash differs'))
                stage=root/f'executions/{family}/stages-{hp:03d}'/(planned['id']+'.stage.pdf')
                if file_hash(stage)!=measured['outputStageHash']:misses.append(issue('actual-stage-hash',planned['id'],'actual PDF stage bytes differ'))
                prev=measured['outputStageHash']
        with fitz.open(pdf) as actual:
            for item in ep['items']:
                n=int(item['pageId'].split('.p')[-1])-1;page=actual[n];page.set_rotation(0)
                goldpage=a['pages'][n];b=next(b for b in goldpage['blocks'] if b['id']==item['blockId'])
                spans=[''.join(chr(c[0]) for c in s['chars']) for s in page.get_texttrace()]
                present=any(norm(b['displayText']) in norm(text) for text in spans)
                if present!=item['nativePresenceExpected']:misses.append(issue('decoy-native-presence',b['id'],dict(actual=present,expected=item['nativePresenceExpected'])))
                if not plan['pages'][n]['hardScan'] and b['templateId']=='hidden.decoy':
                    pix=page.get_pixmap(dpi=150,clip=fitz.Rect(b['bboxPt']),alpha=False)
                    if np.any(np.frombuffer(pix.samples,np.uint8)!=255):misses.append(issue('actual-decoy-cover',b['id'],'native render contains nonwhite pixels under the declared white cover'))
        cases.append(dict(id=case['id'],pageCount=profile['pageCount'],hardPages=len(hard),sha256=case['sha256']))
    return dict(passed=not misses,misses=misses,counts=dict(counts),cases=cases,acceptance='not-scored; requires coordinator audit and independent final judge',selfScore=None)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,required=True);p.add_argument('--spec',type=Path,required=True);p.add_argument('--report',type=Path,required=True);args=p.parse_args()
    result=check_corpus(args.root,load(args.spec));save(args.report,result);print(json.dumps(dict(passed=result['passed'],counts=result['counts'],misses=len(result['misses']))));return 0 if result['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
