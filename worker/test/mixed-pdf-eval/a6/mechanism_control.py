"""Independent constructed characters; no candidate prose or family content."""
from __future__ import annotations
import argparse
from pathlib import Path
import subprocess
from contract import FONTS, save, tool_receipt, digest
from writer_scene import baseline_shift


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    graphic=args.output/'independent-vector.svg'
    save(graphic,b'<svg xmlns="http://www.w3.org/2000/svg" width="300pt" height="40pt" viewBox="0 0 300 40"><path d="M 5,20 C 40,3 80,37 120,20 L 200,20" fill="none" stroke="rgb(45,81,122)" stroke-width="0.65"/><text x="5" y="10" style="font-family:Liberation Mono;font-size:9px;fill:rgb(20,25,30)">Hgj 1.25 +/-</text></svg>')
    pages = []
    for p in range(1, 11):
        prefix = f'control.p{p:02d}'
        blocks = []
        for i, (kind, size) in enumerate([('sans', 10), ('mono', 9), ('mono', 10), ('sans', 13), ('sans', 8), ('mono', 8), ('sans', 9)]):
            y = 40 + i * 35
            blocks.append(dict(id=prefix+f'.font{i}', box=[39, y, 560, y+30],
                runs=[dict(text='Hgjpqy 0123456789 +/-()[] .,:; Wm_', font=kind, size=size,
                           baselineShiftPct=baseline_shift(kind,size,20*.8))], leading=20))
        panel = prefix + '.owner'
        blocks.append(dict(id=prefix+'.vector',box=[39,285,339,325],graphic=str(graphic)))
        blocks.append(dict(id=panel, box=[32, 330, 580, 700], background=[.96, .97, .98], runs=[]))
        blocks.append(dict(id=prefix+'.owned-text', owner=panel, box=[39, 340, 560, 370],
            runs=[dict(text='Hg jpy +-= / 314159', font='sans', size=10,
                       baselineShiftPct=baseline_shift('sans',10,14.7705*.8))], leading=14.7705))
        table = dict(data=[['Tier', 'Two words', '', 'Unit']] + [['ROW01', '12.345', '67.890', '89.2 U'] for _ in range(7)],
                     widths=[81]*4, rowHeight=12.25, padding=1, ruled=True, spans=[[0, 1, 0, 2]])
        blocks.append(dict(id=prefix+'.table', owner=panel, box=[39, 400, 363, 498],
            runs=[dict(text='', font='mono', size=10,
                       baselineShiftPct=baseline_shift('mono',10,12.25*.8+.3))], table=table))
        pages.append(dict(number=p, blocks=blocks, paintOrder=[b['id'] for b in blocks]))
    scene = dict(kind='independent mechanism control; not a candidate revision', pages=pages)
    save(args.output/'scene.json', scene)
    save(args.output/'tools.json', tool_receipt())
    subprocess.run(['/usr/bin/python3', str(Path(__file__).with_name('writer_native.py')),
        str(args.output/'scene.json'), str(args.output/'writer'), '--profile', str(args.output/'profile')], check=True)


if __name__ == '__main__': main()
