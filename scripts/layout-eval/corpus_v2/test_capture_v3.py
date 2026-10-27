"""Procedural capture variants: deterministic plates, exact calibration, parent links, occlusion."""
import json
import os
import tempfile
import unittest
from pathlib import Path

try:
    from .page_v3 import PageV3
    from . import capture_v3
except ImportError:
    from page_v3 import PageV3
    import capture_v3

RECIPE = {'perspective': .03, 'rotation_deg': 2, 'shadow': {'polygon': [[.6, 0], [1, 0], [1, 1], [.8, 1]], 'strength': .4},
          'occluder': {'polygon': [[.1, .45], [.9, .5], [.9, .55], [.1, .5]]}}


class CaptureV3(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='layout-capture-v3-', dir=os.environ.get('TMPDIR', str(Path.home() / 'tmp/agents')))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        p = PageV3('parent', 400, 560, cluster='c', features=['t'], brief='t')
        p.text('A heading', 30, 30, 340, 26, 'sans-bold', label='title')
        p.text('Body text that runs across the middle of the page where the occluder lies.', 30, 250, 340, 18)
        p.finalize(self.root)

    def test_plate_is_deterministic_and_not_ai(self):
        a = capture_v3.plate((400, 560), RECIPE, 5)
        b = capture_v3.plate((400, 560), RECIPE, 5)
        self.assertEqual(a[0].tobytes(), b[0].tobytes())
        self.assertEqual(a[1], b[1])
        self.assertFalse(a[3]['ai_generated'])
        self.assertTrue(a[3]['not_a_photograph'])

    def test_variant_links_parent_and_records_occlusion(self):
        rows = capture_v3.make_variant(self.root, 'parent', 'parent-cap', RECIPE, 5, [('gaussian-blur', 1.2)])
        self.assertEqual([r['id'] for r in rows], ['parent-cap', 'parent-cap-blur'])
        cap = json.loads(Path(rows[0]['reference_path']).read_text())
        self.assertEqual(cap['capture']['source_id'], 'parent')
        calibration = cap['capture']['calibration']
        self.assertFalse(calibration['plate_generation']['ai_generated'])
        body = next(r for r in cap['regions'] if r['label'] == 'paragraph')
        self.assertLess(body['visibility'], 1.0)
        blur = json.loads(Path(rows[1]['reference_path']).read_text())
        self.assertEqual(blur['capture']['source_id'], 'parent')
        self.assertEqual(blur['capture']['parent_id'], 'parent-cap')


if __name__ == '__main__':
    unittest.main()
