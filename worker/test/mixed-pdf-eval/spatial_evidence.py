"""Retain extractor word geometry and transformed authored formula regions.

Raw word coordinates are not yet a certificate of region grounding. In
particular Poppler rotation/crop conventions require independent conformance
checks before normalization; no function here opens the acceptance gate.
"""
import csv
import io
import math
import re
import unicodedata
import xml.etree.ElementTree as ET

SCHEMA='mixed-pdf-word-evidence@1'


def box(values):
    values=[float(v) for v in values]
    if len(values)!=4 or not all(math.isfinite(v) for v in values) or values[0]>=values[2] or values[1]>=values[3]:
        raise ValueError('invalid-word-evidence-box')
    return values


def size(values):
    values=[float(v) for v in values]
    if len(values)!=2 or not all(math.isfinite(v) and v>0 for v in values):
        raise ValueError('invalid-word-evidence-size')
    return values


def parse_poppler_bbox(data):
    # This local harness processes original synthetic inputs only. Entity-bearing
    # XML is unnecessary and rejected even though ElementTree does not fetch DTDs.
    if b'<!ENTITY' in data.upper():raise ValueError('entity-in-word-evidence')
    root=ET.fromstring(data)
    pages=[]
    local=lambda element:element.tag.rsplit('}',1)[-1]
    for page in root.iter():
        if local(page)!='page':continue
        dimensions=size([page.attrib['width'],page.attrib['height']]);words=[]
        for line_index,line in enumerate(e for e in page.iter() if local(e)=='line'):
            for word in (e for e in line.iter() if local(e)=='word'):
                text=''.join(word.itertext())
                if not text.strip():continue
                bounds=box([word.attrib[k] for k in ['xMin','yMin','xMax','yMax']])
                words.append(dict(text=text,bbox=bounds,line=line_index,order=len(words)))
        pages.append(dict(schema=SCHEMA,basis='poppler-page-points',size=dimensions,
                          normalizationVerified=False,words=words))
    if not pages:raise ValueError('missing-word-evidence-pages')
    return pages


def parse_tesseract_tsv(text):
    rows=list(csv.DictReader(io.StringIO(text),delimiter='\t',quoting=csv.QUOTE_NONE))
    page_rows=[r for r in rows if r['level']=='1']
    if len(page_rows)!=1:raise ValueError('ocr-word-evidence-page-count')
    dimensions=size([page_rows[0]['width'],page_rows[0]['height']]);words=[]
    for row in rows:
        if row['level']!='5' or not row['text'].strip():continue
        confidence=float(row['conf'])
        if not math.isfinite(confidence):raise ValueError('invalid-word-confidence')
        if confidence<0:continue
        if confidence>100:raise ValueError('invalid-word-confidence')
        x,y,w,h=[float(row[k]) for k in ['left','top','width','height']]
        bounds=box([x,y,x+w,y+h])
        if bounds[0]<0 or bounds[1]<0 or bounds[2]>dimensions[0] or bounds[3]>dimensions[1]:
            raise ValueError('ocr-word-evidence-outside-image')
        words.append(dict(text=row['text'],bbox=bounds,confidence=confidence,
                          line=[int(row[k]) for k in ['block_num','par_num','line_num']],order=len(words)))
    return dict(schema=SCHEMA,basis='tesseract-raster-pixels',size=dimensions,
                normalizationVerified=False,words=words)


def formula_regions(page):
    """Use final transformed visible glyphs, never untransformed block boxes."""
    blocks=[b for b in page['blocks'] if b['visible'] and b['formula'] is not None]
    if not blocks:return []
    if 'glyphTransforms' not in page:return None
    dimensions=size(page['sizePt']);transforms={g['id']:g for g in page['glyphTransforms']}
    if len(transforms)!=len(page['glyphTransforms']):raise ValueError('duplicate-glyph-geometry')
    regions=[]
    for block in blocks:
        ids=[g['id'] for g in block['glyphs'] if g['visible'] and not g['text'].isspace()]
        if not ids or len(ids)!=len(set(ids)):raise ValueError('incomplete-formula-glyphs')
        bounds=[]
        for identifier in ids:
            transformed=transforms.get(identifier)
            if transformed is None or not transformed['visible']:raise ValueError('missing-visible-formula-geometry')
            rect=box(transformed['displayBboxPt'])
            if rect[0]<0 or rect[1]<0 or rect[2]>dimensions[0] or rect[3]>dimensions[1]:
                raise ValueError('formula-geometry-outside-page')
            bounds.append(rect)
        union=[min(r[0] for r in bounds),min(r[1] for r in bounds),max(r[2] for r in bounds),max(r[3] for r in bounds)]
        regions.append(dict(blockId=block['id'],text=block['formula']['display'],
                            bboxNormalized=[union[0]/dimensions[0],union[1]/dimensions[1],union[2]/dimensions[0],union[3]/dimensions[1]],
                            glyphIds=ids,basis='final-display-visible-glyphs'))
    return regions


def normalize_word_evidence(evidence):
    """Normalize supported coordinates; independent grounding remains unverified.

    Poppler's default bbox mode rotates MediaBox coordinates but reports its
    unrotated dimensions. Raster coordinates already follow the rendered view.
    Unknown box origins/modes are refused rather than guessed.
    """
    import copy
    result=copy.deepcopy(evidence)
    if evidence.get('schema')!=SCHEMA:raise ValueError('unsupported-word-evidence')
    geometry=evidence['pdfGeometry'];display=size(geometry['displaySizePt'])
    rotation=geometry['rotationDegrees']
    if type(rotation) is not int or rotation not in [0,90,180,270]:raise ValueError('unsupported-page-rotation')
    media=box(geometry['mediaBoxPt']);crop=box(geometry['cropBoxPt'])
    if media[:2]!=[0,0]:raise ValueError('unsupported-media-origin')
    width,height=media[2:]
    if crop[0]<0 or crop[1]<0 or crop[2]>width or crop[3]>height:raise ValueError('crop-outside-media')
    cw,ch=crop[2]-crop[0],crop[3]-crop[1]
    expected=[ch,cw] if rotation in [90,270] else [cw,ch]
    if any(abs(a-b)>1e-6 for a,b in zip(display,expected)):raise ValueError('inconsistent-display-geometry')
    dimensions=size(evidence['size']);basis=evidence['basis']
    if basis=='poppler-page-points':
        if evidence.get('pageBox')!='media' or any(abs(a-b)>1e-6 for a,b in zip(dimensions,[width,height])):
            raise ValueError('unsupported-poppler-coordinate-contract')
        x0,y0,x1,y1=crop
        origin={0:[x0,y0],90:[height-y1,x0],180:[width-x1,height-y1],270:[y0,width-x1]}[rotation]
        scale=[1,1]
    elif basis=='tesseract-raster-pixels':
        render=size(evidence['renderSizePixels']);dpi=float(evidence['renderDpi'])
        if not math.isfinite(dpi) or dpi<=0 or render!=dimensions:
            raise ValueError('inconsistent-render-geometry')
        if any(abs(p-math.ceil(pt*dpi/72))>1 for p,pt in zip(render,display)):
            raise ValueError('inconsistent-render-scale')
        origin=[0,0];scale=[display[0]/render[0],display[1]/render[1]]
    else:raise ValueError('unsupported-word-coordinate-basis')
    for word in result['words']:
        rect=box(word['bbox'])
        projected=[(rect[i]-origin[i%2])*scale[i%2] for i in range(4)]
        word['bboxNormalized']=[projected[i]/display[i%2] for i in range(4)]
        word['clippedByDisplay']=projected[0]<0 or projected[1]<0 or projected[2]>display[0] or projected[3]>display[1]
    result['normalizedBasis']='final-display-fractions'
    result['normalizationContract']='zero-origin-media-and-crop@1'
    result['normalizationVerified']=False
    return result


def formula_region_diagnostics(regions, evidence):
    """Compare literal formula text using words from its declared display region.

    This is an exploratory diagnostic, not an acceptance certificate. In
    particular extractor coordinates, visible ink and reference declarations
    still need independently validated provenance. A matching quotation outside
    the declared region cannot supply words to this comparison.
    """
    if evidence.get('schema')!=SCHEMA or evidence.get('normalizedBasis')!='final-display-fractions':
        raise ValueError('missing-normalized-region-evidence')
    if regions is None:raise ValueError('missing-reference-formula-regions')
    region_boxes=[];identifiers=set()
    for region in regions:
        identifier=region['blockId'];bounds=box(region['bboxNormalized'])
        if not isinstance(identifier,str) or not identifier or identifier in identifiers:
            raise ValueError('invalid-formula-region-identity')
        if any(v<0 or v>1 for v in bounds) or not isinstance(region['text'],str) or not region['text'].strip():
            raise ValueError('invalid-formula-region')
        identifiers.add(identifier);region_boxes.append(bounds)
    assigned=[[] for _ in regions];issues=[[] for _ in regions];orders=set()
    for word in evidence['words']:
        order=word['order'];bounds=box(word['bboxNormalized'])
        if type(order) is not int or order<0 or order in orders or not isinstance(word['text'],str):
            raise ValueError('invalid-region-word')
        orders.add(order)
        area=(bounds[2]-bounds[0])*(bounds[3]-bounds[1]);hits=[]
        for index,target in enumerate(region_boxes):
            overlap=max(0,min(bounds[2],target[2])-max(bounds[0],target[0]))*max(0,min(bounds[3],target[3])-max(bounds[1],target[1]))
            if overlap>0:hits.append((index,overlap/area))
        if not hits:continue
        if len(hits)>1:
            for index,_ in hits:issues[index].append(dict(kind='competing-regions',wordOrder=order))
            continue
        index,fraction=hits[0];target=region_boxes[index]
        center=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2]
        # Recompute clipping here instead of trusting the supplied flag. This
        # interface also receives retained evidence independently of its parser.
        if (any(v<0 or v>1 for v in bounds) or word.get('clippedByDisplay') is not False or fraction<.5
                or not (target[0]<=center[0]<=target[2] and target[1]<=center[1]<=target[3])):
            issues[index].append(dict(kind='boundary-word',wordOrder=order))
            continue
        assigned[index].append(word)
    # Preserve mathematical case, grouping, operators and identifier boundaries;
    # accept only whitespace and extractor word segmentation differences.
    lex=lambda text:re.findall(r'[^\W\d]\w*|\d+(?:\.\d+)?|[^\s]',unicodedata.normalize('NFC',text),re.UNICODE)
    results=[]
    for index,region in enumerate(regions):
        words=sorted(assigned[index],key=lambda word:word['order'])
        actual=' '.join(word['text'] for word in words)
        results.append(dict(blockId=region['blockId'],expectedText=region['text'],extractedText=actual,
                            wordOrders=[word['order'] for word in words],issues=issues[index],
                            literalMatch=not issues[index] and lex(actual)==lex(region['text'])))
    return dict(schema='mixed-pdf-formula-region-diagnostic@1',regions=results,
                literalRegionRecall=sum(row['literalMatch'] for row in results)/len(results) if results else None,
                acceptanceEvidenceComplete=False,blockingEvidence=['unverified-region-grounding'],
                scope='literal-text-in-declared-regions-diagnostic')
