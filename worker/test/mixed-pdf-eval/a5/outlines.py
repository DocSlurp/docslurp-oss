"""Outline actual native glyphs without re-distilling or moving their origins."""
from io import BytesIO
import fitz
from fontTools.pens.basePen import BasePen
from reportlab.pdfgen import canvas
from support import *
from check import native_glyphs


def outline_bodies(authoring,native,path):
    out=BytesIO();c=canvas.Canvas(out,pagesize=(612,792),invariant=1,pdfVersion=(1,7))
    class Pen(BasePen):
        def __init__(self,gs):super().__init__(gs);self.path=c.beginPath()
        def _moveTo(self,p):self.path.moveTo(*p)
        def _lineTo(self,p):self.path.lineTo(*p)
        def _curveToOne(self,a,b,d):self.path.curveTo(*a,*b,*d)
        def _closePath(self):self.path.close()
        def _endPath(self):pass
    with fitz.open(native) as doc:
        for page,auth in zip(doc,authoring['pages']):
            if auth['number'] in [4,9]:
                actual,_=native_glyphs(doc,page)
                boxes=[b['containerPt'] for b in auth['blocks'] if b['templateId'] in ['body.1','body.2']]
                for glyph in actual:
                    if not any(contains(box,glyph['ink']) for box in boxes):continue
                    reference=FONTS['mono' if 'Mono' in glyph['font'] else 'sans'];name=reference.cmap[ord(glyph['text'])]
                    pen=Pen(reference.set);reference.set[name].draw(pen)
                    c.saveState()
                    # ReportLab's default six-decimal fp_str rounds 20/255 and
                    # 25/255 downward enough for MuPDF's byte conversion to
                    # change every solid interior pixel. Preserve native paint
                    # precision rather than approximating the already emitted
                    # color. These are finite numeric PDF values, never input
                    # strings or content-dependent color fitting.
                    assert len(glyph['color'])==3
                    c._code.append(' '.join(f'{v:.10f}' for v in glyph['color'])+' rg')
                    c.setFillAlpha(glyph['opacity']);c.translate(glyph['origin'][0],792-glyph['origin'][1]);c.scale(glyph['size']/reference.upem,glyph['size']/reference.upem);c.drawPath(pen.path,fill=1,stroke=0);c.restoreState()
            c.showPage()
    c.save();save(path,out.getvalue())
