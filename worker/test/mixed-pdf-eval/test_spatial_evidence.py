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
