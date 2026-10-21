"""V3 builder gates: glyph coverage, explicit table rules/spans, imported-transcript confidence."""
import json
import os
import tempfile
import unittest
from pathlib import Path

try:
    from .page import Page
    from .page_v3 import PageV3, missing_glyphs
except ImportError:
    from page import Page
    from page_v3 import PageV3, missing_glyphs


def v3(identifier, width=600, height=500):
    return PageV3(identifier, width, height, cluster='test-cluster', features=['test'], brief='unit test')


class V3Contracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='layout-v3-contract-', dir=os.environ.get('TMPDIR', str(Path.home() / 'tmp/agents')))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_missing_glyphs_fail_before_any_raster(self):
        self.assertEqual(missing_glyphs('hebrew', 'שלום עולם'), [])
        self.assertTrue(missing_glyphs('sans', 'שלום'))
        p = v3('glyphs')
        with self.assertRaisesRegex(ValueError, 'lacks glyphs'):
            p.text('नमस्ते', 10, 10, 300, 20, 'sans')
        self.assertFalse((self.root / 'images/glyphs.png').exists())

    def test_script_faces_shape_and_ttc_index_is_honoured(self):
        p = v3('scripts')
        p.text('दैनिक जमा पर्ची', 20, 20, 500, 26, 'deva', language='hi')
        p.text('ביטוח בריאות', 20, 80, 500, 26, 'hebrew', direction='rtl', language='he')
        p.text('数据中心', 20, 140, 500, 26, 'cjk-sc', language='zh-Hans')
        self.assertEqual(p.font('cjk-sc', 20).getname()[0], 'Noto Sans CJK SC')
        row = p.finalize(self.root)
        self.assertEqual(len(row['regions']), 3)
        self.assertIn('ביטוח בריאות', (self.root / 'expected/scripts.md').read_text())

    def test_borderless_table_draws_no_rules_and_keeps_spanning_headers(self):
        p = v3('borderless')
        start = len(p.source['commands'])
        region = p.table_v3([20, 20, 580, 300], [[('', 1), ('2025', 2), ('2026', 2)], [('Item', 1), ('H1', 1), ('H2', 1), ('H1', 1), ('H2', 1)]],
                            [['Rent', '10', '11', '12', ''], ['Power', '3', '4', '5', '6']], [.32, .17, .17, .17, .17], rules='none')
        ops = {c['op'] for c in p.source['commands'][start:]}
        self.assertEqual(ops, {'text'})
        attrs = region['attributes']
        self.assertEqual((attrs['rules_condition_tag'], attrs['header_rows'], attrs['multi_level_header']), ('borderless', 2, True))
        self.assertTrue(any(c['empty'] and not c['is_header'] for c in attrs['cells']))
        p.finalize(self.root)
        md = (self.root / 'expected/borderless.md').read_text().splitlines()
        self.assertEqual(md[0], '|  | 2025 |  | 2026 |  |')
        self.assertEqual(len({line.count('|') for line in md if line.startswith('|')}), 1)
        with self.assertRaisesRegex(ValueError, 'fills'):
            v3('filled').table_v3([0, 0, 100, 100], [[('a', 1)]], [['b']], [1], rules='none', zebra='#eee')

    def test_legacy_table_markdown_is_unchanged(self):
        p = Page('legacy', 400, 300)
        p.table([20, 20, 380, 200], ['A', 'B'], [['1', '2']])
        p.finalize(self.root)
        self.assertEqual((self.root / 'expected/legacy.md').read_text(), '| A | B |\n| --- | --- |\n| 1 | 2 |\n')

    def test_imported_transcript_override_and_evidence_are_recorded(self):
        p = v3('override')
        p.source['extra_evidence'] = {'archive-transcript': {'actor': 'archive', 'actorType': 'institution', 'model': None, 'method': 'crowd transcript', 'scope': 'text', 'independentOfAuthor': True}}
        p.region('paragraph', [10, 10, 200, 100], 'Dear Sir', confidence_overrides={'textTranscription': {'score': .25, 'status': 'imported', 'basis': ['archive transcript'], 'provenance': ['archive-transcript']}})
        p.finalize(self.root)
        confidence = json.loads((self.root / 'confidence/override.json').read_text())
        self.assertEqual(confidence['regions'][0]['axes']['textTranscription']['score'], .25)
        self.assertIn('archive-transcript', confidence['evidence'])
        bad = v3('bad')
        bad.region('paragraph', [10, 10, 200, 100], 'x', confidence_overrides={'textTranscription': {'score': None, 'status': 'n/a', 'basis': [], 'provenance': []}})
        with self.assertRaisesRegex(ValueError, 'reason'):
            bad.finalize(self.root)

    def test_chart_axis_and_legend_text_belong_to_chart(self):
        p = v3('chart', 700, 500)
        p.chart_v3([20, 20, 680, 460], 'grouped-bar', ['Q1', 'Q2', 'Q3'], {'North': [3, 5, 4], 'South': [2, 6, 7]}, title='Orders', y_label='Units')
        row = p.finalize(self.root)
        self.assertEqual([r['label'] for r in row['regions']], ['chart'])
        contract = json.loads((self.root / 'contracts/chart.json').read_text())
        self.assertTrue(all(b['parent_region_id'] == 'r000' for b in contract['annotation_granularity']['text_blocks']))
        self.assertIn('North', (self.root / 'expected/chart.md').read_text())


if __name__ == '__main__':
    unittest.main()
