#!/usr/bin/env python3
"""Render the deliberately composed V3 pages; never automatic population expansion.

Writes the V2 artifact layout (sources/, references/, expected/, contracts/,
confidence/, images/, pilot-manifest.jsonl) so coverage.py and freeze-style
tooling apply unchanged. Re-executes with PYTHONHASHSEED=0 so source JSON key
order (font provenance is collected from a set) is byte-reproducible.
"""
import argparse
import importlib
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
MODULES = ['v3_multilingual', 'v3_tables', 'v3_charts_slides', 'v3_forms_receipts', 'v3_science', 'v3_photo_pages', 'v3_historic']


def contact_sheet(rows, root, path, cols=6, tw=300, th=470):
    sheet = Image.new('RGB', (cols * tw, ((len(rows) + cols - 1) // cols) * th), '#d9dfda')
    d = ImageDraw.Draw(sheet)
    for index, row in enumerate(rows):
        with Image.open(root / row['image_path']) as im:
            im = im.convert('RGB')
            im.thumbnail((tw - 20, th - 50))
            x, y = index % cols * tw + 10, index // cols * th + 10
            sheet.paste(im, (x, y))
        d.text((x, y + th - 38), row['id'][:44], fill='#20352d')
    sheet.save(path, quality=90)


def main():
    if os.environ.get('PYTHONHASHSEED') != '0':
        os.environ['PYTHONHASHSEED'] = '0'
        os.execv(sys.executable, [sys.executable] + sys.argv)
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--modules', nargs='*', default=MODULES)
    p.add_argument('--manifest', action='store_true', help='Write pilot-manifest.jsonl and contact sheet (full module set only)')
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows = []
    for name in args.modules:
        module = importlib.import_module('corpus_v2.' + name)
        for page in module.build():
            row = page.finalize(args.output)
            corpus = page.source['corpus']
            row['metadata'].update(source_cluster=corpus['source_cluster'], source_family=corpus['source_cluster'],
                                   declared_features=corpus['declared_features'], builder_module=name)
            rows.append(row)
    if args.manifest:
        if sorted(args.modules) != sorted(MODULES):
            raise SystemExit('--manifest requires the full module set')
        with (args.output / 'pilot-manifest.jsonl').open('w') as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
    contact_sheet(rows, args.output, args.output / ('v3-contact-sheet.jpg' if args.manifest else 'preview-contact-sheet.jpg'))
    print(json.dumps({'pages': len(rows), 'ids': [r['id'] for r in rows], 'review_status': 'awaiting-visual-review-not-benchmark-admitted'}, indent=1))


if __name__ == '__main__':
    main()
