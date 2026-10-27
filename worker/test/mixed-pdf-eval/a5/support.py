"""Attempt-5 pre-export ink metrics. Only clean-inputs is a dependency."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import unicodedata
from functools import lru_cache
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen

ROOT = Path(__file__).resolve().parent
CLEAN = ROOT / 'clean-inputs'
for key in ('TMPDIR', 'TMP', 'TEMP'):
    os.environ[key] = '/home/dan/tmp/agents'
for key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ[key] = '1'


def canonical(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def digest(v):
    return hashlib.sha256(v if isinstance(v, bytes) else v.encode() if isinstance(v, str) else canonical(v)).hexdigest()


def freeze(v, key):
    v[key] = digest({k: x for k, x in v.items() if k != key})
    return v


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = value if isinstance(value, bytes) else value.encode() if isinstance(value, str) else canonical(value) + b'\n'
    if path.exists():
        assert path.read_bytes() == data, f'Immutable artifact differs: {path}'
    else:
        path.write_bytes(data)


def verify_clean():
    allow = json.loads((CLEAN / 'allowlist.json').read_text())
    for name, expected in allow['files'].items():
        assert digest((CLEAN / name).read_bytes()) == expected, name
    return allow


def normalized(text):
    return ' '.join(unicodedata.normalize('NFC', text).split())


def words(text):
    return [w for w in normalized(text).split() if any(c.isalnum() for c in w)]


def union(boxes):
    boxes = [b for b in boxes if b is not None]
    assert boxes, 'Empty occupied support'
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def contains(a, b):
    return a[0]-1e-8 <= b[0] <= b[2] <= a[2]+1e-8 and a[1]-1e-8 <= b[1] <= b[3] <= a[3]+1e-8


def area(b):
    return max(0, b[2]-b[0]) * max(0, b[3]-b[1])


def intersect(a, b):
    return [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]


def iou(a, b):
    overlap = area(intersect(a, b))
    return overlap / (area(a)+area(b)-overlap) if area(a)+area(b)-overlap else 1


class Font:
    def __init__(self, kind):
        self.kind = kind
        self.family = 'Liberation ' + ('Sans' if kind == 'sans' else 'Mono')
        self.path = Path(subprocess.check_output(['fc-match', '-f', '%{file}', self.family]).decode())
        self.hash = digest(self.path.read_bytes())
        self.tt = TTFont(self.path)
        self.upem = self.tt['head'].unitsPerEm
        self.asc = self.tt['hhea'].ascent/self.upem
        self.desc = self.tt['hhea'].descent/self.upem
        self.cmap = self.tt.getBestCmap()
        self.set = self.tt.getGlyphSet()

    @lru_cache(maxsize=None)
    def glyph(self, char):
        assert ord(char) in self.cmap, (self.family, repr(char))
        name = self.cmap[ord(char)]
        pen = BoundsPen(self.set)
        self.set[name].draw(pen)
        advance = self.tt['hmtx'][name][0]/self.upem
        return name, self.tt.getGlyphID(name), advance, pen.bounds

    @lru_cache(maxsize=100000)
    def width(self, text, size):
        return sum(self.glyph(c)[2]*size for c in text)

    def run(self, leaf_id, text, baseline, size, offset=0, rotation=0):
        x, y = baseline
        out = []
        for i, char in enumerate(text):
            name, gid, advance, bounds = self.glyph(char)
            ink = None
            if bounds:
                a,b,c,d = [v*size/self.upem for v in bounds]
                raw = [x+a,y-d,x+c,y-b]
                if rotation:
                    import math
                    r = math.radians(rotation)
                    co, si = math.cos(r), math.sin(r)
                    def point(xx,yy):
                        dx,dy = xx-baseline[0],yy-baseline[1]
                        return baseline[0]+co*dx-si*dy,baseline[1]+si*dx+co*dy
                    pts = [point(xx,yy) for xx,yy in [(raw[0],raw[1]),(raw[2],raw[1]),(raw[2],raw[3]),(raw[0],raw[3])]]
                    ink = [min(p[0] for p in pts),min(p[1] for p in pts),max(p[0] for p in pts),max(p[1] for p in pts)]
                else:
                    ink = raw
            import math
            r = math.radians(rotation)
            bx = baseline[0]+math.cos(r)*(x-baseline[0])
            by = baseline[1]+math.sin(r)*(x-baseline[0])
            out.append(dict(id=f'{leaf_id}.g{offset+i:04d}',text=char,fontHash=self.hash,sizePt=size,
                baselinePt=[bx,by],rotationDegrees=rotation,expectedInkPt=ink,logicalOffset=offset+i))
            x += advance*size
        return out


FONTS = {k: Font(k) for k in ['sans', 'mono']}


def split_lines(text, count, width, font, size):
    if '\n' in text:
        lines = text.split('\n')
        assert len(lines) == count
        assert all(font.width(x,size) <= width for x in lines)
        return lines
    ws = normalized(text).split()
    @lru_cache(maxsize=None)
    def solve(i,n):
        if n == 0:
            return (0,[]) if i == len(ws) else None
        best = None
        for j in range(i+1,len(ws)-n+2):
            line = ' '.join(ws[i:j]); w = font.width(line,size)
            if w > width:
                break
            first=font.glyph(line[0])[3]
            last=font.glyph(line[-1])
            # A legal advance width is insufficient: an italic-like negative
            # side bearing or a final overhang must not cross the envelope.
            if first and first[0] < 0:
                continue
            if last[3] and w-last[2]*size+last[3][2]*size/font.upem > width:
                continue
            rest = solve(j,n-1)
            if rest is not None:
                cost = (width-w)**2 * (.04 if n == 1 else 1)+rest[0]
                if best is None or cost < best[0]:
                    best = cost,[line]+rest[1]
        return best
    result = solve(0,count)
    if result is None:
        raise ValueError(f'No legal line breaks ({count} lines, {width} pt): {text}')
    return result[1]


def paint_components(blocks):
    remaining = {b['id']: b for b in blocks}
    def expanded(b):
        x,y,z,w = b['containerPt'];return [x-2,y-2,z+2,w+2]
    components = []
    while remaining:
        seed = min(remaining); comp = [remaining.pop(seed)]
        for b in comp:
            for key,other in list(remaining.items()):
                overlap=intersect(expanded(b),expanded(other))
                if overlap[0]<=overlap[2] and overlap[1]<=overlap[3]:
                    comp.append(remaining.pop(key))
        components.append(sorted(b['id'] for b in comp))
    return sorted(components)


def paint_order(blocks, fid, pnum, permuted):
    components = paint_components(blocks)
    assert len(components) >= 2, 'Independent paint-component permutation infeasible'
    chosen = components
    if permuted:
        chosen = sorted(components, key=lambda c:digest(f'e-stream-permute-v1|{fid}|{pnum}|'+ '|'.join(c)))
        if chosen == components:
            chosen = components[1:]+components[:1]
    lookup = {b['id']: b for b in blocks}
    order = [bid for comp in chosen for bid in sorted(comp,key=lambda bid:(lookup[bid]['zOrder'],bid))]
    return components,order
