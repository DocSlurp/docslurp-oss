import copy
import unittest

from spatial_evidence import formula_regions,parse_poppler_bbox,parse_tesseract_tsv


class SpatialEvidenceTests(unittest.TestCase):
    def test_poppler_capture_retains_order_and_raw_basis(self):
        xml=b'<html xmlns="http://www.w3.org/1999/xhtml"><page width="612" height="792"><flow><line><word xMin="10" yMin="20" xMax="30" yMax="35">q</word><word xMin="40" yMin="20" xMax="50" yMax="35">=</word></line></flow></page></html>'
        result=parse_poppler_bbox(xml)[0]
        self.assertEqual([w['text'] for w in result['words']],['q','='])
        self.assertEqual(result['words'][1]['bbox'],[40,20,50,35])
        self.assertFalse(result['normalizationVerified'])
        for bad in [xml.replace(b'xMax="30"',b'xMax="nan"'),b'<!DOCTYPE x [<!ENTITY e "bad">]><html/>',b'<html/>']:
            with self.assertRaises(ValueError):parse_poppler_bbox(bad)

    def tsv(self):
        return ('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
                '1\t1\t0\t0\t0\t0\t0\t0\t1200\t1600\t-1\t\n'
                '5\t1\t2\t1\t3\t1\t20\t40\t80\t30\t95\tq\n')

    def test_ocr_capture_and_malformed_bounds(self):
        result=parse_tesseract_tsv(self.tsv())
        self.assertEqual(result['words'][0]['line'],[2,1,3])
        self.assertEqual(result['words'][0]['bbox'],[20,40,100,70])
        self.assertFalse(result['normalizationVerified'])
        for bad in [self.tsv().replace('\t80\t30\t','\t1800\t30\t'),self.tsv().replace('\t95\t','\tnan\t'),self.tsv()+self.tsv().splitlines()[1]+'\n']:
            with self.assertRaises(ValueError):parse_tesseract_tsv(bad)

    def test_ocr_requires_integer_pixels_and_single_image_page_identity(self):
        for bad in [self.tsv().replace('\t80\t30\t','\t80.5\t30\t'),
                    self.tsv().replace('\t1200\t1600\t','\t1200.25\t1600\t'),
                    self.tsv().replace('5\t1\t2\t','5\t99\t2\t'),
                    self.tsv().replace('1\t1\t0\t','1\t99\t0\t')]:
            with self.assertRaises(ValueError):parse_tesseract_tsv(bad)

    def test_ocr_rejects_malformed_rows_levels_and_hierarchy(self):
        for bad in [self.tsv()+'bogus\tgarbage\n',
                    self.tsv().rstrip()+'\textra\n',
                    self.tsv().replace('5\t1\t2\t','6\t1\t2\t'),
                    self.tsv().replace('5\t1\t2\t','5\t1\t0\t'),
                    self.tsv().replace('level\tpage_num','level\tother')]:
            with self.assertRaises(ValueError):parse_tesseract_tsv(bad)

    def page(self):
        return dict(sizePt=[792,612],blocks=[dict(id='rule',visible=True,formula=dict(display='q'),
                    bboxPt=[1,2,3,4],glyphs=[dict(id='g',visible=True,text='q')])],
                    glyphTransforms=[dict(id='g',visible=True,displayBboxPt=[700,100,720,115])])

    def test_reference_regions_use_final_display_geometry(self):
        page=self.page();result=formula_regions(page)[0]
        self.assertEqual(result['bboxNormalized'],[700/792,100/612,720/792,115/612])
        self.assertEqual(result['glyphIds'],['g'])
        changed=copy.deepcopy(page);del changed['glyphTransforms']
        self.assertIsNone(formula_regions(changed))
        for mutate in [lambda p:p['glyphTransforms'].clear(),lambda p:p['glyphTransforms'].append(p['glyphTransforms'][0]),lambda p:p['glyphTransforms'][0].update(displayBboxPt=[700,100,800,115])]:
            changed=copy.deepcopy(page);mutate(changed)
            with self.assertRaises(ValueError):formula_regions(changed)

    def test_normalization_matches_independent_rotation_crop_controls(self):
        from spatial_evidence import normalize_word_evidence
        # Retained Poppler observations from independently authored controls.
        cases=[(0,[70,101.384,103.348,112.484],[40,61.384,73.348,72.484],[550,710]),
               (90,[679.516,70,690.616,103.348],[637.516,40,648.616,73.348],[710,550]),
               (180,[508.652,679.516,542,690.616],[476.652,637.516,510,648.616],[550,710]),
               (270,[101.384,508.652,112.484,542],[61.384,476.652,72.484,510],[710,550])]
        for rotation,raw,expected,display in cases:
            data=dict(schema='mixed-pdf-word-evidence@1',basis='poppler-page-points',pageBox='media',
                      size=[612,792],words=[dict(text='quartz',bbox=raw)],pdfGeometry=dict(
                          rotationDegrees=rotation,displaySizePt=display,cropBoxPt=[30,40,580,750],mediaBoxPt=[0,0,612,792]))
            before=copy.deepcopy(data);result=normalize_word_evidence(data)
            self.assertEqual(data,before)
            for actual,target in zip(result['words'][0]['bboxNormalized'],[expected[i]/display[i%2] for i in range(4)]):
                self.assertAlmostEqual(actual,target,places=8)
            self.assertFalse(result['normalizationVerified'])
        for field,value in [('pageBox','crop'),('size',[792,612])]:
            changed=copy.deepcopy(data);changed[field]=value
            with self.assertRaises(ValueError):normalize_word_evidence(changed)

    def test_raster_normalization_requires_matching_render_metadata(self):
        from spatial_evidence import normalize_word_evidence
        data=dict(schema='mixed-pdf-word-evidence@1',basis='tesseract-raster-pixels',size=[100,200],
                  renderSizePixels=[100,200],renderDpi=144,words=[dict(text='q',bbox=[40,20,80,40])],
                  pdfGeometry=dict(rotationDegrees=0,displaySizePt=[50,100],cropBoxPt=[0,0,50,100],mediaBoxPt=[0,0,50,100]))
        result=normalize_word_evidence(data)
        self.assertEqual(result['words'][0]['bboxNormalized'],[.4,.1,.8,.2])
        self.assertFalse(result['words'][0]['clippedByDisplay'])
        self.assertFalse(result['normalizationVerified'])
        for field,value in [('renderSizePixels',[200,100]),('renderDpi',72)]:
            changed=copy.deepcopy(data);changed[field]=value
            with self.assertRaises(ValueError):normalize_word_evidence(changed)
        changed=copy.deepcopy(data);changed['size']=[100.25,200];changed['renderSizePixels']=[100.25,200]
        with self.assertRaisesRegex(ValueError,'invalid-raster-dimensions'):normalize_word_evidence(changed)
