"""Read untouched original PDFs and ODTs; preserve actual traces and image evidence."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys
import traceback
import xml.etree.ElementTree as ET
import zipfile

import pymupdf
import pikepdf
from PIL import Image

HANDOFF=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a7-clean-r2')
OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4')
sys.path.insert(0,str(HANDOFF/'generic'))
from native_geometry import native_glyphs
from support import iou,union

def save(path,value):
    assert not path.exists(),path
    path.write_text(json.dumps(value,indent=2,default=lambda x:list(x))+'\n')

def paint_trace(path):
    # Retain raw text-show operators and all effective inherited clip descriptions.
    # No operation is deduplicated, suppressed, replayed or reordered.
    records=[]
    with pikepdf.open(path) as pdf:
        page=pdf.pages[0];stack=[];clips=[];pending=[];ctm=[]
        for index,ins in enumerate(pikepdf.parse_content_stream(page)):
            op=str(ins.operator);args=str(ins.operands)
            if op=='q':stack.append((list(clips),list(ctm)))
            elif op=='Q':
                if stack:clips,ctm=stack.pop()
            elif op=='cm':ctm.append(args)
            elif op in ['m','l','c','re','h']:pending.append({'op':op,'operands':args})
            elif op in ['W','W*']:clips.append({'rule':op,'path':list(pending),'ctmAtClip':list(ctm)})
            elif op in ['n','S','s','f','f*','B','B*','b','b*']:pending=[]
            if op in ['Tj','TJ',"'",'"','Do','S','s','f','f*','B','B*','b','b*']:
                records.append({'instructionIndex':index,'operator':op,'operands':args,'effectiveClipDescriptions':list(clips),
                                'ctmHistory':list(ctm),'graphicsSaveDepth':len(stack)})
        return {'source':str(path),'page':1,'rawPaintOperations':records,
                'textShowOperationCount':sum(r['operator'] in ['Tj','TJ',"'",'"'] for r in records),
                'clipPolicy':'Raw inherited clips retained; nonrectangular clipping is not reduced to an invented bounding rectangle.',
                'rewrites':0,'deduplicatedOperations':0}

def expected_glyphs(support):
    unique={}
    for leaf in support['leaves']:
        for g in leaf['glyphs']:
            if g['id'] in unique:assert unique[g['id']]==g
            unique[g['id']]=g
    # Parent serialization refers to the same logical IDs; this is not native-op deduplication.
    return [g for g in unique.values() if g['expectedInkPt'] is not None and not g['text'].isspace()]

def inspect_pdf(path,stem,support):
    evidence=OUT/'evidence';evidence.mkdir(exist_ok=True)
    result={'pdf':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'observedAtUtc':datetime.now(timezone.utc).isoformat(),
            'producer':'writer' if 'writer' in path.name else 'reportlab','misses':[]}
    with pymupdf.open(path) as doc:
        result['pageCount']=len(doc);result['metadata']=doc.metadata;result['pdfFormat']=doc.metadata.get('format')
        assert len(doc)==1
        page=doc[0];result['sizePt']=list(page.rect)
        pix=page.get_pixmap(dpi=300,alpha=False)
        full=evidence/(path.stem+'-full-300.png');pix.save(full)
        page.get_pixmap(dpi=150,alpha=False).save(evidence/(path.stem+'-full-150.png'))
        crops={'prose':[30,100,580,420 if 'E1' in stem else 224],
               'technical':[312,112,580,258] if 'E1' in stem else [30,290,520,464] if 'E2' in stem else [30,225,580,447],
               'discussion':[30,445 if 'E1' in stem else 467,582,610]}
        if 'E3' in stem:crops['chart']=[310,222,580,449]
        for name,box in crops.items():page.get_pixmap(dpi=300,clip=pymupdf.Rect(box),alpha=False).save(evidence/(path.stem+'-'+name+'-300.png'))
        (evidence/(path.stem+'.extracted.txt')).write_text(page.get_text(sort=False))
        (evidence/(path.stem+'.original-stream.txt')).write_bytes(page.read_contents())
        save(evidence/(path.stem+'.bboxlog.json'),page.get_bboxlog())
        save(evidence/(path.stem+'.texttrace.json'),page.get_texttrace())
        save(evidence/(path.stem+'.drawings.json'),page.get_drawings())
        save(evidence/(path.stem+'.paint-trace.json'),paint_trace(path))
        expected=expected_glyphs(support)
        try:
            actual,fonts=native_glyphs(doc,page)
            save(evidence/(path.stem+'.native-glyphs.json'),{'glyphs':actual,'embeddedFontHashes':fonts})
            ec=Counter(g['text'] for g in expected);ac=Counter(g['text'] for g in actual)
            result['expectedMeaningfulGlyphs']=len(expected);result['actualMeaningfulGlyphs']=len(actual)
            result['missingGlyphCharacters']=dict(ec-ac);result['extraGlyphCharacters']=dict(ac-ec)
            result['exactGlyphMultiset']=ec==ac
            # Raw duplicates are findings even if their final pixels coincide.
            duplicate=Counter((g['text'],tuple(round(x,3) for x in g['origin']),g['font'],g['size']) for g in actual)
            result['rawRepeatedNativeGlyphOperations']=[{'text':k[0],'origin':k[1],'font':k[2],'size':k[3],'count':v} for k,v in duplicate.items() if v>1]
            remaining=set(range(len(actual)));matches=[];glyphs_by_id={};failed=[];glyph_outline_diagnostics=[]
            image=Image.frombytes('RGB',[pix.width,pix.height],pix.samples)
            for e in expected:
                candidates=[i for i in remaining if actual[i]['text']==e['text']]
                if not candidates:failed.append({'id':e['id'],'kind':'missing glyph'});continue
                i=min(candidates,key=lambda i:sum((a-b)**2 for a,b in zip(actual[i]['origin'],e['baselinePt'])))
                a=actual[i];remaining.remove(i)
                delta=max(abs(a-b) for a,b in zip(a['origin'],e['baselinePt']))
                overlap=iou(e['expectedInkPt'],a['ink']);glyphs_by_id[e['id']]=a
                # Positive actual raster-ink probe, explicitly weaker than full glyph-mask conservation.
                x,y,r,b=a['ink'];box=(max(0,math.floor(x*300/72)),max(0,math.floor(y*300/72)),min(image.width,math.ceil(r*300/72)),min(image.height,math.ceil(b*300/72)))
                crop=image.crop(box);dark=sum(max(pixel)-min(pixel)<100 and min(pixel)<150 for pixel in crop.getdata())
                match={'id':e['id'],'actualIndex':i,'anchorDeltaMaxPt':delta,'inkIoU':overlap,'sizePt':a['size'],'darkPixelsInInkBox':dark}
                matches.append(match)
                if overlap<.7:glyph_outline_diagnostics.append(match)
                if delta>2 or abs(a['size']-e['sizePt'])>.3 or dark==0:failed.append(match)
            aggregates=[]
            for l in support['leaves']:
                ids=[g['id'] for g in l['glyphs'] if g['expectedInkPt'] and not g['text'].isspace()]
                # Primitives have separate paint evidence, not a padded text comparison.
                if not ids or l['primitivePaths']:continue
                if any(id not in glyphs_by_id for id in ids):continue
                bounds=union([glyphs_by_id[id]['ink'] for id in ids]);score=iou(l['expectedSupportPt'],bounds)
                aggregates.append({'id':l['id'],'actualInkPt':bounds,'expectedInkPt':l['expectedSupportPt'],'inkIoU':score})
                if score<.7:failed.append(aggregates[-1])
            result['glyphOutlineDiagnostics']=glyph_outline_diagnostics
            result['glyphAnchorFontInkFailures']=failed;result['unmatchedActualGlyphs']=len(remaining)
            result['minimumGlyphInkIoU']=min((m['inkIoU'] for m in matches),default=0)
            result['aggregateSupports']=aggregates
            save(evidence/(path.stem+'.glyph-match-details.json'),matches)
            if not result['exactGlyphMultiset']:result['misses'].append('Original native meaningful-glyph multiset differs from frozen logical glyphs.')
            if result['rawRepeatedNativeGlyphOperations']:result['misses'].append('Repeated original native text-show glyph operations; no deduplication applied.')
            if failed:result['misses'].append(f'{len(failed)} glyph/leaf anchor, font, ink or raster-presence checks failed.')
        except Exception:
            result['nativeGeometryError']=traceback.format_exc();result['misses'].append('Native embedded-font/GID inspection failed; no substitute pass.')
        result['limitations']=['Per-glyph positive ink-box probes do not prove complete glyph-mask conservation or interpret all clip paths.',
                               'These one-page originals do not discharge ten-page controls, transforms, source-leakage gates or independent editorial acceptance.']
    return result

def inspect_odt(path,author,plan):
    ns={'draw':'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0','table':'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
        'text':'urn:oasis:names:tc:opendocument:xmlns:text:1.0','svg':'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0'}
    with zipfile.ZipFile(path) as z:xml=z.read('content.xml')
    root=ET.fromstring(xml);parents={child:parent for parent in root.iter() for child in parent}
    def native_text(element):
        value=element.text or ''
        for child in element:
            if child.tag=='{'+ns['text']+'}s':value+=' '*int(child.get('{'+ns['text']+'}c','1'))
            elif child.tag=='{'+ns['text']+'}line-break':value+='\n'
            elif child.tag=='{'+ns['text']+'}tab':value+='\t'
            else:value+=native_text(child)
            value+=child.tail or ''
        return value
    tables=root.findall('.//table:table',ns);assert len(tables)==1
    t=tables[0];rows=t.findall('table:table-row',ns);actual=[];cells=[]
    for ri,row in enumerate(rows):
        ci=0
        for cell in row:
            if cell.tag=='{'+ns['table']+'}covered-table-cell':ci+=1;continue
            if cell.tag!='{'+ns['table']+'}table-cell':continue
            text='\n'.join(native_text(p) for p in cell.findall('text:p',ns))
            cells.append({'row':ri,'column':ci,'text':text,'columnSpan':int(cell.get('{'+ns['table']+'}number-columns-spanned','1'))})
            ci+=1
    misses=[];expected=author['cells']
    for exp,act in zip(expected,cells):
        if (exp['row'],exp['column'],exp['displayLiteral'],exp['columnSpan'])!=(act['row'],act['column'],act['text'],act['columnSpan']):misses.append({'expected':exp,'actual':act})
    if len(cells)!=len(expected):misses.append({'semanticCellCount':len(cells),'expected':len(expected)})
    tableparent=parents[t]
    ancestry=[];e=t
    while e in parents:
        e=parents[e];ancestry.append({'tag':e.tag,'name':e.get('{'+ns['draw']+'}name')})
    objects=[]
    for element in root.iter():
        name=element.get('{'+ns['draw']+'}name')
        if name:
            objects.append({'id':name,'tag':element.tag,'anchorType':element.get('{'+ns['text']+'}anchor-type'),
                            'anchorPage':element.get('{'+ns['text']+'}anchor-page-number'),
                            'zIndex':element.get('{'+ns['draw']+'}z-index'),
                            'actualParentTag':parents[element].tag if element in parents else None})
    return {'odt':str(path),'semanticCells':cells,'semanticCellCount':len(cells),'tableAncestry':ancestry,'objects':objects,
            'misses':misses,'source':'actual saved-and-reloaded ODT content.xml, not a requested proxy identity',
            'expectedObjectCount':len(plan['objects'])}

def main():
    reports=[];odts=[]
    for path in sorted(OUT.glob('*.drawing-plan.json')):
        stem=path.name.removesuffix('.drawing-plan.json');support=json.loads((OUT/(stem+'.support.json')).read_text())
        plan=json.loads(path.read_text());author=json.loads((OUT/(stem+'.exact-authoring.json')).read_text())
        for producer in ['reportlab','writer']:
            pdf=OUT/(stem+'-'+producer+'-original.pdf')
            if pdf.exists():reports.append(inspect_pdf(pdf,stem,support))
            else:reports.append({'pdf':str(pdf),'misses':['Missing native PDF']})
        odt=OUT/(stem+'-writer-original.odt')
        if odt.exists():odts.append(inspect_odt(odt,author,plan))
    save(OUT/'actual-original-inspection.json',{'observedAtUtc':datetime.now(timezone.utc).isoformat(),'pdfs':reports,'editableWriter':odts,
        'noCandidateRepair':True,'noReordering':True,'nativeOperationsDeduplicated':0})
    for r in reports:print(Path(r['pdf']).name,'glyphs',r.get('expectedMeaningfulGlyphs'),r.get('actualMeaningfulGlyphs'),'misses',r['misses'])
    print('Editable Writer cell counts:',[r['semanticCellCount'] for r in odts])

if __name__=='__main__':main()
