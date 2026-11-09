#!/usr/bin/env python3
"""Check generated training outputs; no source corpus or quality judging."""
import hashlib
import importlib.util
import json
import math
import re
import subprocess
import sys
from pathlib import Path
import fitz
from PIL import Image, ImageChops, ImageDraw, ImageStat

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('fools_gold_build_v2.py'))
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
for start in range(0,90,18):
    pairs = {((f//6)%3, (f+f//6)%6) for f in range(start,start+18)}
    assert len(pairs) == 18
assert [sum(builder.split_for(f)==split for f in range(90)) for split in ('train','tune','heldout')] == [54,18,18]
root = Path(sys.argv[1])
manifest = json.loads((root/'manifest.json').read_text())
assert manifest['schema'] == 'mixed-pdf-authored@v2'
assert manifest['families'] == 3 and manifest['pageCount'] == 180
cases = manifest['cases']
assert len(cases) == 18 and cases == sorted(cases, key=lambda c:c['id'])
assert {c['family'] for c in cases} == {'mixed-source-0000', 'mixed-source-0006', 'mixed-source-0012'}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for name, expected in manifest['files'].items(): assert sha(root/name) == expected, name
for family in sorted({c['family'] for c in cases}):
    first = next(c for c in cases if c['family']==family)
    model = json.loads((root/first['source']).read_text())
    assert model['family'] == family and model['split'] == 'train'
    builder.verify_native(model, root/first['native'])
    with fitz.open(root/first['native']) as native:
        for key, value in builder.document_metadata(model).items(): assert native.metadata[key] == value
    assert first['producerVersion'] and first['compositor']
    assert len({p['paragraphs'][-1] for p in model['pages']}) >= 6
    assert len({p['paragraphs'][-2] for p in model['pages']}) >= 6
    fno = int(family[-4:]); assert model == builder.author(fno)
    for page in model['pages']:
        assert 140 <= sum(len(p.split()) for p in page['paragraphs'][:3]) <= 220
        assert all(isinstance(x,str) for x in page['sections']+page['paragraphs'])
        assert 25 <= len(page['paragraphs'][-2].split()) <= 45
        assert 40 <= len(page['paragraphs'][-1].split()) <= 80
        assert page['tables'] or page['charts']
        if page['charts']:
            chart = page['charts'][0]
            assert len(chart['series']) == 2
            exact = [chart['title'], chart['xLabel'], chart['yLabel'], *[s['name'] for s in chart['series']], *chart['xTicks'], *chart['yTicks']]
            assert chart['visibleText'] == exact
            lines = page['expectedMarkdown'].splitlines()
            assert all(t in lines for t in exact)
            assert all(t in page['sections'] for t in exact)
def compare_visible_region(source, output, rect, max_mean_error):
    screen_rect = rect * output.rotation_matrix if output.rotation else rect
    a = source.get_pixmap(matrix=fitz.Matrix(2,2), clip=rect, alpha=False)
    b = output.get_pixmap(matrix=fitz.Matrix(2,2), clip=screen_rect, alpha=False)
    original = Image.frombytes('RGB', (a.width,a.height), a.samples)
    if output.rotation == 90: original = original.transpose(Image.Transpose.ROTATE_270)
    candidate = Image.frombytes('RGB', (b.width,b.height), b.samples)
    assert original.size == candidate.size
    error = sum(ImageStat.Stat(ImageChops.difference(original,candidate)).mean)/3
    assert error <= max_mean_error, (error, max_mean_error)

for case in cases:
    assert case['split'] == 'train' and case['id'].endswith(f"hard-{case['hardPercent']:03d}")
    pdf, label, source = root/case['pdf'], root/case['labels'], root/case['source']
    assert sha(pdf) == case['sha256'] and sha(label) == case['labelHash'] and sha(source) == case['sourceLayoutHash']
    gold = json.loads(label.read_text()); model = json.loads(source.read_text())
    assert gold['family'] == case['family'] and gold['split'] == case['split']
    assert len(gold['pages']) == len(case['pages']) == 10
    assert sum(p['hardScan'] for p in case['pages']) == case['hardPercent']//10
    subprocess.run(['qpdf','--check',str(pdf)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with fitz.open(pdf) as doc, fitz.open(root/case['native']) as native_doc:
        assert len(doc) == 10 and not doc.is_encrypted
        for page_index, (page, actual, source_page, meta) in enumerate(zip(doc, gold['pages'], model['pages'], case['pages'])):
            assert 'difficultyPlan' not in actual
            assert page.rotation == meta['rotationDegrees']
            assert page.rect == (fitz.Rect(0, 0, 792, 612) if page.rotation else fitz.Rect(0, 0, 612, 792))
            assert list(page.rect) == actual['bbox']
            assert actual['excludedText'] == [x['text'] for x in meta['excludedBlocks']]
            assert actual['excludedBlocks'] == meta['excludedBlocks']
            assert all(t not in actual['expectedMarkdown'] for t in actual['excludedText'])
            assert actual['pageId'] == source_page['pageId'] == meta['pageId']
            if meta['hardScan']:
                assert not page.get_text().strip()
                assert len(page.get_images()) == 1 and not page.get_drawings()
                assert not meta['excludedBlocks'] and not meta['outlinedSections'] and page.rotation == 0
                for block, original in zip(actual['blocks'], source_page['blocks']):
                    expected = builder.transformed_bbox(original['bbox'], meta['skewDegrees'], meta['dpi'])
                    assert all(abs(a-b) < .00001 for a,b in zip(block['bbox'], expected))
            else:
                blocks = {b['id']:b for b in source_page['blocks']}
                actual_blocks = {b['id']:b for b in actual['blocks']}
                for block_id, block in blocks.items():
                    expected = list(fitz.Rect(block['bbox']) * page.rotation_matrix) if page.rotation else block['bbox']
                    assert all(abs(a-b)<.001 for a,b in zip(actual_blocks[block_id]['bbox'], expected))
                for block_id in meta['rasterizedSections']:
                    region = fitz.Rect(blocks[block_id]['bbox'])
                    assert not page.get_textbox(region).strip()
                    compare_visible_region(native_doc[page_index], page, region, 1)
                if meta['insetScreenshot']:
                    inset = next(b for b in source_page['blocks'] if b['role'] == 'inset')
                    inset_region = fitz.Rect(inset['bbox'])
                    assert not page.get_textbox(inset_region).strip()
                    compare_visible_region(native_doc[page_index], page, inset_region, 1)
                outlined = {b['id'] for b in meta['outlinedSections']}
                for outline in meta['outlinedSections']:
                    block = blocks[outline['id']]
                    rect = fitz.Rect(block['bbox'])
                    assert not page.get_textbox(rect).strip() and outline['method'] == 'svg-glyph-paths'
                    assert outline['meanPixelError'] <= 8
                    compare_visible_region(native_doc[page_index], page, rect, 8)
                    assert any(fitz.Rect(d['rect']).intersects(rect) for d in page.get_drawings())
                    for image in page.get_images(full=True):
                        assert not any(r.intersects(rect) for r in page.get_image_rects(image[0]))
                    expected = list(rect * page.rotation_matrix) if page.rotation else block['bbox']
                    assert all(abs(a-b)<.001 for a,b in zip(outline['bbox'], expected))
                for decoy in meta['excludedBlocks']:
                    embedded = [font for font in page.get_fonts() if font[4] == 'NotoDecoy']
                    assert embedded and doc.extract_font(embedded[0][0])[3]
                    assert decoy['mode'] == 'occluded'
                    rect = fitz.Rect(decoy['bbox'])
                    unrotated = rect * page.derotation_matrix if page.rotation else rect
                    assert decoy['text'] in page.get_textbox(unrotated)
                    pixels = page.get_pixmap(clip=rect, alpha=False)
                    assert min(pixels.samples) >= 250
                for block in source_page['blocks']:
                    if block['id'] in outlined or block['id'] in meta['rasterizedSections'] or (block['role'] == 'inset' and meta['insetScreenshot']): continue
                    local = ' '.join(re.sub(r'-\s*\n\s*', '-', page.get_textbox(fitz.Rect(block['bbox']))).split())
                    if block['role'] == 'chart': wanted = block_chart_text = source_page['charts'][0]['visibleText']
                    elif block['role'] == 'table': wanted = [cell for row in source_page['tables'][0]['rows'] for cell in row]
                    elif block['role'] == 'inset': wanted = [block['title'],block['text']]
                    else: wanted = [block['text']]
                    assert all(' '.join(value.split()) in local for value in wanted), (case['id'],block['id'])
    if case['hardPercent'] == 0:
        assert sum(len(p['rasterizedSections']) for p in case['pages']) == round(30*case['baseRegionRasterShare'])
# Validate the analytic top-left rotation against Pillow's actual pixel transform.
for angle in (-.7,.7):
    dpi=110; width=math.ceil(612*dpi/72); height=math.ceil(792*dpi/72)
    box=[80,100,150,160]; image=Image.new('L',(width,height)); draw=ImageDraw.Draw(image)
    draw.rectangle((box[0]*width/612,box[1]*height/792,box[2]*width/612,box[3]*height/792),fill=255)
    actual=image.rotate(angle, resample=Image.Resampling.NEAREST).getbbox()
    mapped=builder.transformed_bbox(box,angle,dpi)
    predicted=[mapped[0]*width/612,mapped[1]*height/792,mapped[2]*width/612,mapped[3]*height/792]
    assert all(abs(a-b)<3 for a,b in zip(actual,predicted)), (actual,predicted)
assert any(p['outlinedSections'] for c in cases for p in c['pages'])
assert any(p['excludedBlocks'] for c in cases for p in c['pages'])
assert any(p['rotationDegrees'] == 90 for c in cases for p in c['pages'])
print(f'checked {len(cases)} cases, 180 pages, chart gold, outlines, decoys, rotations, isolation, hashes and qpdf structure')
