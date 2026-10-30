"""Original-content-free, independently invented K controls; never edits candidates."""
import json
from pathlib import Path
import os
import unittest
from io import BytesIO
import pikepdf
import validator as v
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

OUT = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/validation-r1')
CONTROLS = OUT / 'controls'
FONT = '/usr/share/fonts/liberation/LiberationMono-Regular.ttf'

class Controls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        CONTROLS.mkdir(exist_ok=True)
        pdfmetrics.registerFont(TTFont('ValidatorInventedMono', FONT))
        cls.results=[]

    def control(self, name, clip=None, textstate='', matrix='', nested=False, font='ValidatorInventedMono', triangle=False, rotate=False):
        p=CONTROLS/(name+'.pdf'); c=canvas.Canvas(str(p),pagesize=(612,792),invariant=1)
        c.setFont(font,10)
        if nested:
            c.saveState();r=c.beginPath();r.rect(35,690,60,50);c.clipPath(r,stroke=0)
        if triangle:
            r=c.beginPath();r.moveTo(39,700);r.lineTo(80,700);r.lineTo(39,740);r.close();c.clipPath(r,stroke=0)
        if clip:
            r=c.beginPath();r.rect(*clip);c.clipPath(r,stroke=0)
        if matrix:c._code.append(matrix)
        t=c.beginText(39,710);t.setFont(font,10)
        if rotate:t.setTextTransform(0,1,-1,0,100,600)
        if textstate:t._code.append(textstate)
        t.textOut('K');c.drawText(t)
        if nested:c.restoreState()
        c.showPage();c.save()
        return p

    def check(self,p,complete,clean):
        r=v.inspect(p);self.results.append(r)
        self.assertIs(r['completeForObservedMechanisms'],complete,json.dumps(r))
        self.assertIs(r['noOutlineClipMisses'],clean,json.dumps(r))
        (OUT/'control-results.json').write_text(json.dumps(self.results,indent=2)+'\n')
        return r

    def test_exact_positive_and_quarter_turn(self):
        for name,kw in [('positive',{}),('rotated',{'rotate':True}),('uniform-tm',{'textstate':'2 0 0 2 39 600 Tm'}),('uniform-cm',{'matrix':'2 0 0 2 0 -700 cm'})]:
            with self.subTest(name=name):self.check(self.control(name,**kw),True,True)
        r=next(x for x in self.results if Path(x['pdf']).name=='positive.pdf')['frozenResult'];g=r['outlinedGlyphsChecked'];self.assertEqual(g,1)
        self.assertAlmostEqual(r['minimumClipSlackPt'],39.791015625,places=6)

    def test_clipped_all_sides_and_nested(self):
        for name,clip,nest in [('top',(39,700,40,15),False),('bottom',(39,711,40,30),False),('left',(40,700,40,30),False),('right',(39,700,5.85,30),False),('nested',(39,700,5.85,30),True)]:
            with self.subTest(name=name):
                r=self.check(self.control(name,clip=clip,nested=nest),True,False)
                self.assertGreater(len(r['frozenResult']['glyphsOutsideActiveClips']),0)

    def test_unsupported_states_cannot_award_coverage(self):
        cases={'tz50':'50 Tz','tz200':'200 Tz','tz100':'100 Tz','rise':'1 Ts','charspace':'1 Tc','wordspace':'1 Tw','render':'0 Tr','unknown':'1 InventedTextState','gs':'/Invented gs',
               'tm-aniso':'2 0 0 1 39 710 Tm','tm-shear':'1 0 .1 1 39 710 Tm','tm-singular':'0 0 0 0 39 710 Tm','tm-reflect':'-1 0 0 1 39 710 Tm','tm-oblique':'.8 .6 -.6 .8 39 710 Tm','tm-tiny-shear':'1 0 .000000000001 1 39 710 Tm','nan':'NaN 0 Td','infinity':'1e999 0 Td','negative-size':'/F1 -10 Tf','bad-tm':'1 0 0 Tm'}
        for name,state in cases.items():
            with self.subTest(name=name):self.check(self.control(name,textstate=state,clip=(39,700,40,15) if name=='tz50' else None),False,False)
        for name,m in [('cm-aniso','2 0 0 1 0 0 cm'),('cm-shear','1 .1 0 1 0 0 cm'),('cm-singular','0 0 0 0 0 0 cm'),('cm-nonfinite','NaN 0 0 1 0 0 cm')]:
            with self.subTest(name=name):self.check(self.control(name,matrix=m),False,False)

    def test_unsupported_fonts_paths_xobjects_geometry(self):
        self.check(self.control('base14',font='Helvetica'),False,False)
        self.check(self.control('triangle',triangle=True),False,False)
        self.check(self.control('negative-rectangle',clip=(39,700,-40,30)),False,False)
        self.check(self.control('zero-rectangle',clip=(39,700,0,30)),False,False)
        src=self.control('xobject-source')
        for name,extra in [('nested-xobject',b'/Nested Do'),('unbalanced',b'Q'),('unknown-paint',b'1 scn')]:
            p=CONTROLS/(name+'.pdf')
            with pikepdf.open(src) as pdf:
                if name=='nested-xobject':
                    form=pdf.make_stream(b'BT /F1 10 Tf (K) Tj ET');form.Type=pikepdf.Name.XObject;form.Subtype=pikepdf.Name.Form;form.BBox=pikepdf.Array([0,0,100,100]);form.Resources=pdf.pages[0].Resources
                    pdf.pages[0].Resources.XObject=pikepdf.Dictionary(Nested=form)
                pdf.pages[0].Contents=pdf.make_stream(pdf.pages[0].Contents.read_bytes()+b'\n'+extra)
                pdf.save(p)
            self.check(p,False,False)

    def test_reproduce_frozen_false_complete(self):
        p=self.control('known-tz50-false-complete',clip=(39,700,40,15),textstate='50 Tz')
        from types import ModuleType
        h=v.HELPER.read_bytes();self.assertEqual(v.sha(h),v.HELPER_SHA)
        m=ModuleType('frozen_test');exec(compile(h,str(v.HELPER),'exec'),m.__dict__)
        old=m.inspect(p);self.assertTrue(old['completeForObservedMechanisms']);self.assertTrue(old['noOutlineClipMisses'])
        r=self.check(p,False,False)
        from fontTools.ttLib import TTFont as Font
        from fontTools.pens.boundsPen import BoundsPen
        font=Font(FONT);gs=font.getGlyphSet();pen=BoundsPen(gs);gs[font.getBestCmap()[ord('K')]].draw(pen)
        true_top=82-10*pen.bounds[3]/font['head'].unitsPerEm
        self.assertAlmostEqual(true_top,75.4130859375)
        self.assertAlmostEqual(77-true_top,1.5869140625)
        (OUT/'counterexample.json').write_text(json.dumps({'frozenHelper':old,'wrapper':r,'independentTrueTopPt':true_top,'clipTopPt':77,'actualOutsidePt':77-true_top},indent=2)+'\n')

if __name__=='__main__':unittest.main(verbosity=2)
