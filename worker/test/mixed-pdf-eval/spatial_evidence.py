"""Retain extractor word geometry and transformed authored formula regions.

Raw word coordinates are not yet a certificate of region grounding. In
particular Poppler rotation/crop conventions require independent conformance
checks before normalization; no function here opens the acceptance gate.
"""
import csv
import io
import math
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
