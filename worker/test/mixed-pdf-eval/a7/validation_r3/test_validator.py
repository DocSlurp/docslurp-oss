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

OUT = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/validation-r3')
CONTROLS = OUT / 'controls'
FONT = '/usr/share/fonts/liberation/LiberationMono-Regular.ttf'

class Controls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        CONTROLS.mkdir(exist_ok=True)
        pdfmetrics.registerFont(TTFont('ValidatorInventedMono', FONT))
        cls.results=[]

    def control(self, name, clip=None, textstate='', matrix='', nested=False, font='ValidatorInventedMono', triangle=False, rotate=False, paint=None):
        p=CONTROLS/(name+'.pdf'); c=canvas.Canvas(str(p),pagesize=(612,792),invariant=1)
        c.setFont(font,10)
        if paint:
            c.saveState();c.setFillColorRGB(.9,.9,.9);c.rect(*paint,stroke=0,fill=1);c.restoreState()
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
        self.assertIs(r['mechanismCoverageComplete'],complete,json.dumps(r))
        self.assertIs(r['traceObservation']['noMissesAtReportedPrecision'],clean,json.dumps(r))
        self.assertFalse(r['completeForObservedMechanisms'])
        self.assertFalse(r['noOutlineClipMisses'])
        self.assertFalse(r['precision']['exactConservationEvidenceComplete'])
        self.assertIsNone(r['precision']['justifiedGlobalErrorBoundPt'])
        self.assertIsNone(r['precision']['mathematicalNoOutlineClipLoss'])
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
        self.check(self.control('negative-rectangle',clip=(39,700,-40,30)),True,False)
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

    @staticmethod
    def signed_rect(rect, sx, sy):
        x,y,w,h=rect
        return (x if sx>0 else x+w,y if sy>0 else y+h,sx*w,sy*h)

    def test_signed_rectangle_equivalence(self):
        # Same independently invented rectangle in all four signed notations.
        for mechanism in ('paint','clip'):
            baseline=None
            for sx,sy in ((1,1),(-1,1),(1,-1),(-1,-1)):
                name=f'equivalent-{mechanism}-{sx}-{sy}'
                rect=self.signed_rect((35,690,60,50),sx,sy)
                with self.subTest(name=name):
                    r=self.check(self.control(name,**{mechanism:rect}),True,True)
                    actual=r['frozenResult']
                    signature={k:actual[k] for k in ('outlinedGlyphsChecked','minimumClipSlackPt','glyphsOutsideActiveClips','rawSequenceExactlyMatches')}
                    bounds=r['guard']['rectangles'][0]['boundsPt']
                    self.assertEqual(bounds,[35.,690.,95.,740.])
                    if baseline is None:baseline=signature
                    else:self.assertEqual(signature,baseline)

    def test_reversed_clips_still_detect_loss(self):
        for side,rect in [('tip',(39,700,5.85,30)),('top',(39,700,40,15)),('bottom',(39,711,40,30)),('left',(40,700,40,30)),('right',(39,700,5.85,30))]:
            baseline=None
            for sx,sy in ((1,1),(-1,1),(1,-1),(-1,-1)):
                name=f'loss-{side}-{sx}-{sy}'
                with self.subTest(name=name):
                    r=self.check(self.control(name,clip=self.signed_rect(rect,sx,sy)),True,False)
                    misses=r['frozenResult']['glyphsOutsideActiveClips']
                    self.assertTrue(misses)
                    signature=[(m['text'],m['clipPt'],m['outsidePt']) for m in misses]
                    if baseline is None:baseline=signature
                    else:self.assertEqual(signature,baseline)

    def test_rectangle_endpoints_and_mapped_bounds(self):
        bad={
            'zero-width':'39 700 0 30 re', 'zero-height':'39 700 40 0 re',
            'bad-arity':'39 700 40 re', 'nonfinite-rect':'39 700 NaN 30 re',
            'huge-rect':'39 700 1000000000 30 re',
            'endpoint-positive':'900000000 700 200000000 30 re',
            'endpoint-negative':'-900000000 700 -200000000 30 re',
            'mapped-oversize':'2 0 0 2 0 0 cm 600000000 0 -100 30 re',
            'accumulated-mapped':'100 0 0 100 0 0 cm 100 0 0 100 0 0 cm 200000 0 -100 30 re',
            'collapsed-endpoint':'900000000 700 .000000001 30 re',
        }
        for name,ops in bad.items():
            with self.subTest(name=name):self.check(self.control(name,matrix=ops+' n'),False,False)
        # Map each signed rectangle through an accumulated positive similarity;
        # require exact equivalence of all four corners and min/max bounds.
        matrix=(0.,2.,-2.,0.,300.,40.)
        for sx,sy in ((1,1),(-1,1),(1,-1),(-1,-1)):
            self.assertEqual(v.rectangle_geometry(self.signed_rect((35,60,10,20),sx,sy),matrix)['boundsPt'],[140.,110.,180.,130.])
        with self.assertRaises(v.Refusal):v.rectangle_geometry((35,700,float('inf'),30),(1.,0.,0.,1.,0.,0.))

    def test_deferred_clip_regressions_and_canonical_positives(self):
        for name,ops in [
            ('late-evenodd-hole','35 690 60 50 re W* 38 705 10 20 re n'),
            ('late-nonzero-hole','35 690 60 50 re W 48 705 -10 20 re n'),
            ('late-move','35 690 60 50 re W* 38 705 m n'),
            ('late-state','35 690 60 50 re W* q n Q'),
            ('late-repeat-clip','35 690 60 50 re W W* n')]:
            with self.subTest(name=name):
                r=self.check(self.control(name,matrix=ops),False,False)
                self.assertIn('must be immediately terminated',r['failure']['message'])
        for op in ('W','W*'):
            for sx,sy in ((1,1),(-1,1),(1,-1),(-1,-1)):
                rect=' '.join(str(v) for v in self.signed_rect((35,690,60,50),sx,sy))
                r=self.check(self.control(f'canonical-{op.replace("*","star")}-{sx}-{sy}',matrix=rect+' re '+op+' n'),True,True)
                self.assertEqual(r['guard']['immediatelyTerminatedClips'],1)
        # Read the independent invented controls unchanged. Preserve the frozen
        # helper's affirmative outputs and R3's instruction-specific refusals.
        from types import ModuleType
        h=v.HELPER.read_bytes();self.assertEqual(v.sha(h),v.HELPER_SHA)
        m=ModuleType('frozen_clip_regression');exec(compile(h,str(v.HELPER),'exec'),m.__dict__)
        evidence=[]
        for name in ('late-evenodd-hole','late-nonzero-hole'):
            src=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/validation-r2-independent-review/controls')/(name+'.pdf')
            frozen=m.inspect(src);self.assertTrue(frozen['noOutlineClipMisses'])
            guarded=self.check(src,False,False)
            evidence.append({'sourceSha256':v.sha(src.read_bytes()),'frozenResult':frozen,'r3':guarded})
        (OUT/'deferred-clip-regressions.json').write_text(json.dumps(evidence,indent=2)+'\n')

    def test_precision_counterexample_is_not_exact_evidence(self):
        from decimal import Decimal
        from types import ModuleType
        from io import BytesIO
        from fontTools.ttLib import TTFont as Font
        from fontTools.pens.boundsPen import BoundsPen
        import pymupdf
        src=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/validation-r2-independent-review/controls/sub-float32-top-loss.pdf')
        r=self.check(src,True,True)
        self.assertEqual(r['status'],'observed-exact-incomplete')
        h=v.HELPER.read_bytes();m=ModuleType('frozen_precision_regression');exec(compile(h,str(v.HELPER),'exec'),m.__dict__)
        with pikepdf.open(src) as pdf,pymupdf.open(src) as doc:
            raw=list(pikepdf.parse_content_stream(pdf.pages[0]))
            tm=next(i.operands for i in raw if str(i.operator)=='Tm' and str(i.operands[-1])=='710.00001')
            rect=next(i.operands for i in raw if str(i.operator)=='re' and str(i.operands[-1])=='16.58692')
            glyphs,fonts,_=m.actual_outlines(doc,doc[0],pdf.pages[0])
            font=Font(BytesIO(doc.extract_font(pdf.pages[0].Resources.Font[fonts[0]['resource']].objgen[0])[3]))
            gs=font.getGlyphSet();pen=BoundsPen(gs);gs[font.getGlyphOrder()[glyphs[0]['gid']]].draw(pen)
            true_top=Decimal(792)-Decimal(str(tm[-1]))-Decimal(10)*Decimal(pen.bounds[3])/Decimal(font['head'].unitsPerEm)
            clip_top=Decimal(792)-Decimal(str(rect[1]))-Decimal(str(rect[3]))
            self.assertEqual(str(clip_top-true_top),'0.0000040625')
            self.assertGreater(r['frozenResult']['minimumClipSlackPt'],0)
        (OUT/'precision-regression.json').write_text(json.dumps({'r3':r,'independentExactTopPt':str(true_top),'exactClipTopPt':str(clip_top),'exactOutsidePt':str(clip_top-true_top),'note':'One demonstrated counterexample; not a global numeric error bound'},indent=2)+'\n')

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
