#!/usr/bin/env python3
"""Structural checks and previews for authored prototype PDFs; no acceptance judgment."""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

import fitz


def enc(obj):
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2)+'\n').encode()


def digest(data): return hashlib.sha256(data).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('corpus',type=Path)
    args=parser.parse_args(); root=args.corpus
    manifest=json.loads((root/'manifest.json').read_text()); errors=[]; checks=[]
    if manifest['schema']!='mixed-pdf-authored@v2': errors.append('incorrect schema')
    for artifact in manifest.get('artifacts',[]):
        path=root/artifact['path']
        if not path.is_file() or digest(path.read_bytes())!=artifact['sha256']:
            errors.append('artifact hash mismatch: '+artifact['path'])
    if not manifest.get('artifacts'): errors.append('corpus artifact inventory missing')
    if len(manifest['cases'])!=18: errors.append('expected 18 prototype cases')
    if {case['family'] for case in manifest['cases']}!={0,6,12}: errors.append('prototype family set differs')
    if any(case['split']!='train' for case in manifest['cases']): errors.append('prototype contains a non-training split')
    module_path=Path(__file__).with_name('fools_gold_build_v3.py')
    spec=importlib.util.spec_from_file_location('fools_gold_v3_builder',module_path)
    builder=importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
    if manifest['specSha256']!=digest(builder.SPEC.read_bytes()): errors.append('spec hash differs from current spec')
    previews=root/'previews'; previews.mkdir(exist_ok=True)
    for case in manifest['cases']:
        ident=case['id']; f=case['family']; hard=case['hardPercent']
        pdf_path=root/case['pdf']; label_path=root/case['labels']; source_path=root/f'sources/family-{f:04d}/authored.json'
        base_path=root/case['storageBase']
        if digest(pdf_path.read_bytes())!=case['sha256']: errors.append(f'{ident}: PDF hash mismatch')
        if digest(label_path.read_bytes())!=case['labelHash']: errors.append(f'{ident}: label hash mismatch')
        if digest(source_path.read_bytes())!=case['sourceLayoutHash']: errors.append(f'{ident}: source hash mismatch')
        if digest(base_path.read_bytes())!=case['storageBaseHash']: errors.append(f'{ident}: storage base hash mismatch')
        source=json.loads(source_path.read_text()); labels=json.loads(label_path.read_text()); doc=fitz.open(pdf_path); base=fitz.open(base_path)
        if len(doc)!=10 or len(labels['pages'])!=10: errors.append(f'{ident}: expected ten pages')
        if len([p for p in case['pages'] if p['hardScan']]) != hard//10: errors.append(f'{ident}: incorrect scan count')
        qpdf=subprocess.run(['qpdf','--check',str(pdf_path)],capture_output=True,text=True)
        if qpdf.returncode: errors.append(f'{ident}: qpdf check failed: {qpdf.stderr.strip()}')
        if doc.is_encrypted: errors.append(f'{ident}: encrypted PDF')
        for i,(page,original,ref,step) in enumerate(zip(doc,source['pages'],labels['pages'],case['pages'])):
            context=f'{ident} page {i+1}'
            original_copy=dict(original); expected_hash=original_copy.pop('canonicalContentHash')
            if digest(enc(original_copy))!=expected_hash: errors.append(context+': authored content hash mismatch')
            if any(ref[k]!=original[k] for k in ('pageId','expectedMarkdown','sections','paragraphs','tables','charts','formulas','readingOrder','bbox')):
                errors.append(context+': label differs from authored reference')
            if ref['transformation']!=step: errors.append(context+': transform differs from plan')
            excluded=[step['decoy']] if step['decoy'] and not step['hardScan'] else []
            if ref['excludedText']!=excluded: errors.append(context+': decoy binding mismatch')
            if page.rotation!=step['rotation']: errors.append(context+': rotation differs')
            if step['hardScan'] and page.get_text().strip(): errors.append(context+': scanned page contains extractable text')
            if not step['hardScan']:
                if step['decoy'] and step['decoy'] not in page.get_text():
                    errors.append(context+': authored occluded decoy is missing')
                if step['outlinedBlock']:
                    outlined=fitz.Rect(original['bbox'][step['outlinedBlock']])
                    if page.get_textbox(outlined).strip(): errors.append(context+': outlined text is still selectable')
                for block in original['blocks']:
                    raster=block['id'] in step['sectionRasterIds'] or (block['id']=='inset' and step['insetScreenshot'])
                    if raster and page.get_textbox(fitz.Rect(block['bbox'])).strip():
                        errors.append(context+': raster section retains extractable text: '+block['id'])
            a=page.get_pixmap(matrix=fitz.Matrix(1,1),alpha=False); b=base[i].get_pixmap(matrix=fitz.Matrix(1,1),alpha=False)
            if a.width!=b.width or a.height!=b.height or a.samples!=b.samples: errors.append(context+': qpdf changed pixels')
            for block in original['blocks']:
                x0,y0,x1,y1=block['bbox']
                if not (0<=x0<x1<=612 and 0<=y0<y1<=792): errors.append(context+': invalid geometry '+block['id'])
            if hard in (0,100) and i in (0,1):
                page.set_rotation(0)
                pix=page.get_pixmap(matrix=fitz.Matrix(1.5,1.5),alpha=False)
                pix.save(str(previews/f'family-{f:04d}-hard-{hard:03d}-page-{i+1:02d}.png'))
                for name in (['formula'] if i==0 else ['technical']):
                    bbox=fitz.Rect(original['bbox'][name]); bbox.x0-=8; bbox.y0-=8; bbox.x1+=8; bbox.y1+=8
                    pix=page.get_pixmap(matrix=fitz.Matrix(3,3),clip=bbox,alpha=False)
                    pix.save(str(previews/f'family-{f:04d}-hard-{hard:03d}-{name}.png'))
        checks.append({'id':ident,'pages':len(doc),'hardPages':hard//10,'qpdfCheck':qpdf.returncode,'pixelComparison':'performed for every page'})
        doc.close(); base.close()
    repeat=[]
    for f in (0,6,12):
        for p in range(10):
            a=builder.model(f,p); b=builder.model(f,p)
            content_same=enc(a)==enc(b)
            formula=next(block for block in a['blocks'] if block['id']=='formula')
            first=builder.block_pdf(a,formula); second=builder.block_pdf(b,formula)
            formula_doc=fitz.open(stream=first,filetype='pdf')
            expected=formula['text']; actual=formula_doc[0].get_text().rstrip('\n')
            if expected!=actual: errors.append(f'family {f} page {p+1}: native formula literal mismatch: {actual!r}')
            bounds=fitz.Rect(formula['bbox'])
            if any(not bounds.contains(fitz.Rect(word[:4])) for word in formula_doc[0].get_text('words')):
                errors.append(f'family {f} page {p+1}: formula glyph outside authored box')
            if not content_same or first!=second: errors.append(f'family {f} page {p+1}: authored/formula repeat differs')
            if a['charts']:
                chart_doc=fitz.open(root/f'sources/family-{f:04d}/native/page-{p+1:02d}-technical.pdf')
                printed=chart_doc[0].get_text().splitlines(); chart=a['charts'][0]
                expected_labels=[chart['title'],chart['xLabel'],chart['yLabel'],*chart['xTicks'],*chart['yTicks'],*chart['legend']]
                if any(label not in printed for label in expected_labels):
                    errors.append(f'family {f} page {p+1}: native chart label is missing')
            repeat.append({'family':f,'page':p+1,'authoredSha256':digest(enc(a)),'formulaPdfSha256':digest(first),'matchesRepeat':content_same and first==second})
    result={'status':'structural checks only; independent audit and judge pending','errors':errors,'cases':checks,'deterministicRepeat':repeat}
    (root/'structural-checks.json').write_bytes(enc(result))
    print(json.dumps({'cases':len(checks),'errors':len(errors),'report':str(root/'structural-checks.json'),'previews':str(previews)},indent=2))
    if errors:
        print('\n'.join(errors[:30]))
        raise SystemExit(1)


if __name__=='__main__': main()
