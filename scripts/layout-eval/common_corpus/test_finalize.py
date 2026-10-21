"""Source grouping invariants independent of document rendering or model outputs."""
import json, os, tempfile, unittest
from pathlib import Path
from finalize import freeze


class SourceSplitTests(unittest.TestCase):
    def fixture(self,root):
        for name in ['manifest.jsonl','source-contract-qa.json','publication/RIGHTS-RECEIPT.json']:
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('{}')
        rows=[]
        for i in range(12):
            document='paired-document' if i in [0,1] else f'document-{i}'
            labels=['paragraph','table'] if i>=6 else ['paragraph']
            if i==5:labels.append('form')
            rows.append({'id':f'page-{i:02d}','image_path':f'images/{i}.png','regions':[{'label':label} for label in labels],
                         'metadata':{'document_id':document,'template_instance':document,'image_sha256':f'image-{i}',
                                     'source_path':f'sources/{i}.json','reference_path':f'references/{i}.json',
                                     'source_module':'business' if i>=6 else 'editorial'}})
        return rows

    def test_multipage_closure_unique_feature_and_exact_counts(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            root=Path(d);rows=self.fixture(root);freeze(root,rows,{'warnings':[]})
            self.assertEqual(sum(r['split']=='dev' for r in rows),8)
            self.assertEqual(sum(r['split']=='holdout' for r in rows),4)
            self.assertEqual(rows[0]['split'],rows[1]['split'])
            self.assertEqual(rows[5]['split'],'dev')
            self.assertTrue(any(r['split']=='holdout' and r['metadata']['source_module']=='business' for r in rows))
            self.assertTrue(any(r['split']=='holdout' and r['metadata']['source_module']=='editorial' for r in rows))

    def test_lock_rejects_changed_annotation(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            root=Path(d);rows=self.fixture(root);freeze(root,rows,{'warnings':[]})
            changed=self.fixture(root);changed[3]['regions'][0]['bbox']=[0,0,10,10]
            with self.assertRaisesRegex(ValueError,'changed'):freeze(root,changed,{'warnings':[]})

    def test_unresolved_overlap_cannot_freeze(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            root=Path(d)
            with self.assertRaisesRegex(ValueError,'overlap'):freeze(root,self.fixture(root),{'warnings':[{'type':'glyph-overlap'}]})


if __name__=='__main__':unittest.main()
