"""Outline the DocSlurp wordmark ("Doc" 500 + "Slurp" 800) from Schibsted Grotesk.

Usage: python outline-wordmark.py <schibsted-grotesk-latin-wght-normal.woff2> > wordmark.json
Prints SVG path data in em units scaled to `size`, baseline at y=0, starting at x=0.
"""
import io, json, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

SIZE, TRACK = 34, -0.03  # px, em
src = TTFont(sys.argv[1])
src.flavor = None
buf = io.BytesIO(); src.save(buf); data = buf.getvalue()

def run(text, wght, x0):
    font = instantiateVariableFont(TTFont(io.BytesIO(data)), {"wght": wght})
    upem = font["head"].unitsPerEm; s = SIZE / upem
    face = hb.Face(data); hf = hb.Font(face); hf.set_variations({"wght": wght})
    b = hb.Buffer(); b.add_str(text); b.guess_segment_properties(); hb.shape(hf, b, {"kern": True})
    gs = font.getGlyphSet(); order = font.getGlyphOrder()
    pen = SVGPathPen(gs, ntos=lambda v: f"{round(v, 2):g}")
    x = x0
    for info, pos in zip(b.glyph_infos, b.glyph_positions):
        tp = TransformPen(pen, (s, 0, 0, -s, x + pos.x_offset * s, -pos.y_offset * s))
        gs[order[info.codepoint]].draw(tp)
        x += pos.x_advance * s + TRACK * SIZE
    return pen.getCommands(), x

doc, x = run("Doc", 500, 0)
slurp, x = run("Slurp", 800, x)
print(json.dumps({"size": SIZE, "width": round(x - TRACK * SIZE, 2), "doc": doc, "slurp": slurp}))
