"""Structural correctness checks; fixtures are generated in task-owned scratch."""
import copy
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('corpus',Path(__file__).with_name('corpus.py'))
corpus=importlib.util.module_from_spec(spec); spec.loader.exec_module(corpus)

class CorpusTests(unittest.TestCase):
    def test_all_families_source_reference_and_render(self):
        for index in range(48):
            with self.subTest(index=index):
                src=corpus.build_source(index,12); ref=corpus.prepare_reference(src)
                image=corpus.render(ref)
                self.assertEqual(image.size,(ref['width'],ref['height']))
                self.assertEqual(len({r['id'] for r in ref['regions']}),len(ref['regions']))
                self.assertTrue(ref['ground_truth']['absent_labels'])
                for r in ref['regions']:
                    if r['text'] is not None:
                        self.assertEqual(' '.join(r['text'].split()),' '.join(line['text'] for line in r['attributes']['lines']))
    def test_deterministic_source_and_transform(self):
        a=corpus.prepare_reference(corpus.build_source(3,64)); b=corpus.prepare_reference(corpus.build_source(3,64))
        self.assertEqual(a,b)
        ia=corpus.render(a); ib=corpus.render(b)
        for mode in ('phone_hand','scan','skew','rotate90','rotate180','rotate270','low_resolution'):
            xa,ra=corpus.transform(ia,a,mode); xb,rb=corpus.transform(ib,b,mode)
            self.assertEqual(ra,rb); self.assertEqual(xa.tobytes(),xb.tobytes())
    def test_homography_roundtrip(self):
        src=[[0,0],[100,0],[100,200],[0,200]]; dst=[[3,20],[95,2],[112,190],[2,202]]
        mat=corpus.homography(src,dst)
        np.testing.assert_allclose(corpus.mapped(src,mat),dst,atol=1e-8)
        np.testing.assert_allclose(corpus.mapped(dst,np.linalg.inv(mat)),src,atol=1e-8)
    def test_rotation_cell_and_region_coordinates(self):
        ref=corpus.prepare_reference(corpus.build_source(14,2)); image=corpus.render(ref)
        rotated,r=corpus.transform(image,ref,'rotate90')
        self.assertEqual(rotated.size,(image.height,image.width))
        table=next(x for x in ref['regions'] if x['label']=='table'); after=next(x for x in r['regions'] if x['label']=='table')
        self.assertEqual(after['polygon'][0],[image.height-table['polygon'][0][1],table['polygon'][0][0]])
        self.assertNotEqual(table['attributes']['cells'][0]['polygon'],after['attributes']['cells'][0]['polygon'])
    def test_split_has_no_source_group_leakage_and_tables_pair(self):
        sources=[corpus.build_source(i,2) for i in range(256)]
        for family in corpus.FAMILIES:
            self.assertEqual({s['split'] for s in sources if s['source_family']==family},{'train','dev','holdout'})
        for template in {s['template_family'] for s in sources}:
            self.assertEqual(len({s['split'] for s in sources if s['template_family']==template}),1)
        tables=[s for s in sources if s['source_family']=='table_continuation']
        for a,b in zip(tables[::2],tables[1::2]):
            self.assertEqual(a['document_id'],b['document_id'])
            ta=next(r for r in a['regions'] if r['label']=='table'); tb=next(r for r in b['regions'] if r['label']=='table')
            self.assertEqual(ta['attributes']['continuation_id'],tb['attributes']['continuation_id'])
            self.assertEqual([a['page_number'],b['page_number']],[1,2])
            self.assertEqual(ta['attributes']['columns'],tb['attributes']['columns'])
            self.assertEqual(ta['attributes']['border'],tb['attributes']['border'])
            self.assertEqual([c['text'] for c in ta['attributes']['cells'] if c['is_header']],[c['text'] for c in tb['attributes']['cells'] if c['is_header']])
            self.assertEqual({c['logical_row'] for c in tb['attributes']['cells'] if c['is_header']},{0})
            left={c['logical_row'] for c in ta['attributes']['cells'] if not c['is_header']}
            right={c['logical_row'] for c in tb['attributes']['cells'] if not c['is_header']}
            self.assertEqual(max(left)+1,min(right))
    def test_text_reference_tight_bounds_preserve_layout_slot(self):
        src=corpus.build_source(0,2); ref=corpus.prepare_reference(src)
        title=next(r for r in ref['regions'] if r['label']=='title')
        slot=title['attributes']['layout_bbox']
        self.assertLess(title['bbox'][3]-title['bbox'][1],slot[3]-slot[1])
        lines=title['attributes']['lines']
        self.assertEqual(title['bbox'],[min(l['bbox'][0] for l in lines),min(l['bbox'][1] for l in lines),max(l['bbox'][2] for l in lines),max(l['bbox'][3] for l in lines)])
    def test_artwork_without_photographic_provenance_is_not_photo(self):
        source=corpus.build_source(10,2)
        self.assertNotIn('photo',{r['label'] for r in source['regions']})
        self.assertTrue(any(r['attributes'].get('photo_placeholder') for r in source['regions']))
    def test_missing_ground_truth_fails(self):
        r=corpus.prepare_reference(corpus.build_source(0,2)); del r['ground_truth'];
        with self.assertRaises(ValueError): corpus.validate_reference(r)
        r=corpus.prepare_reference(corpus.build_source(14,2)); next(x for x in r['regions'] if x['label']=='table')['attributes']['cells']=[]
        with self.assertRaises(ValueError): corpus.validate_reference(r)

if __name__=='__main__': unittest.main()
