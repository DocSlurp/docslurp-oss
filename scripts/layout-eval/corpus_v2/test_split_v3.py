"""Split assignment keeps shared assets and capture variants with their source group."""
import json
import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image

try:
    from .page_v3 import PageV3
    from . import capture_v3, split_v3
except ImportError:
    from page_v3 import PageV3
    import capture_v3
    import split_v3


class SplitV3(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='layout-split-v3-', dir=os.environ.get('TMPDIR', str(Path.home() / 'tmp/agents')))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        photo = self.root / 'shared.png'
        Image.new('RGB', (40, 30), '#884422').save(photo)
        rows = []
        for i in range(8):
            p = PageV3(f'page{i}', 300, 400, cluster=f'cluster{i}', features=['f'], brief='t')
            p.text(f'Title {i}', 20, 20, 260, 20, 'sans-bold', label='title')
            if i in (2, 5):
                p.image(photo, [20, 80, 280, 280], label='photo')
            row = p.finalize(self.root)
            row['metadata'].update(source_cluster=f'cluster{i}', declared_features=['f'])
            rows.append(row)
        (self.root / 'pilot-manifest.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
        capture_v3.make_variant(self.root, 'page3', 'page3-cap', {'perspective': .02}, 1)

    def test_shared_asset_and_variant_follow_group(self):
        _, _, _, _, _, split_of, _, owners = split_v3.assign(self.root)
        self.assertEqual(split_of['page2'], split_of['page5'])
        self.assertEqual(split_of['page3-cap'], split_of['page3'])
        self.assertTrue(any(sorted(ids) == ['page2', 'page5'] for ids in owners.values()))
        self.assertEqual(split_of, split_v3.assign(self.root)[5])
        self.assertEqual(set(split_of.values()) - set(split_v3.SPLITS), set())


if __name__ == '__main__':
    unittest.main()
