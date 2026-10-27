#!/usr/bin/env python3
"""Draw declared region boxes, labels and table cells over a rendered page for visual QA.

Review aid only: writes to a separate directory and never alters corpus artifacts.
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

COLORS = {'paragraph': '#1f77b4', 'title': '#d62728', 'list': '#2ca02c', 'table': '#9467bd', 'chart': '#ff7f0e',
          'photo': '#e377c2', 'logo': '#8c564b', 'formula': '#17becf', 'caption': '#bcbd22', 'header': '#7f7f7f',
          'footer': '#7f7f7f', 'form': '#9467bd', 'illustration': '#ff7f0e', 'figure': '#ff7f0e', 'footnote': '#bcbd22',
          'formula_number': '#17becf', 'code': '#2ca02c', 'seal': '#8c564b', 'number': '#7f7f7f'}


def overlay(root, identifier, out, cells=True):
    reference = json.loads((root / 'references' / f'{identifier}.json').read_text())
    image = Image.open(root / 'images' / f'{identifier}.png').convert('RGB')
    d = ImageDraw.Draw(image, 'RGBA')
    font = ImageFont.truetype('/usr/share/fonts/gsfonts/NimbusSans-Bold.otf', 14)
    for region in reference['regions']:
        color = COLORS.get(region['label'], '#000000')
        b = region['bbox']
        d.rectangle(b, outline=color, width=3)
        if cells:
            for cell in region['attributes'].get('cells', []):
                d.rectangle(cell['bbox'], outline=color + '88', width=1)
        tag = f"{region['id']} {region['label']}"
        w = font.getlength(tag)
        d.rectangle([b[0], b[1] - 17, b[0] + w + 6, b[1]], fill=color)
        d.text((b[0] + 3, b[1] - 16), tag, font=font, fill='#ffffff')
    out.mkdir(parents=True, exist_ok=True)
    image.save(out / f'{identifier}.overlay.png')
    return out / f'{identifier}.overlay.png'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('root', type=Path)
    p.add_argument('ids', nargs='+')
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    for identifier in a.ids:
        print(overlay(a.root, identifier, a.out))


if __name__ == '__main__':
    main()
