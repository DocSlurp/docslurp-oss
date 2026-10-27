import os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from measure import ocr

class TimingTests(unittest.TestCase):
    def test_repeated_pixels_reexecute_when_cache_disabled(self):
        os.environ.setdefault('TMPDIR','/home/dan/tmp/agents')
        def fake_invoke(argv):
            base=Path(argv[2])
            base.with_suffix('.txt').write_text('A word')
            base.with_suffix('.tsv').write_text('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t\n5\t1\t1\t1\t1\t1\t10\t10\t20\t10\t90\tword\n')
            return b'',.1
        with tempfile.TemporaryDirectory(prefix='mixed-cache-test-',dir=os.environ['TMPDIR']) as tmp:
            with patch('measure.invoke',side_effect=fake_invoke) as invoke:
                first=ocr(b'identical-pixels',Path(tmp),150,6,use_cache=False)
                second=ocr(b'identical-pixels',Path(tmp),150,6,use_cache=False)
                self.assertEqual(invoke.call_count,2)
                self.assertEqual(first['wordEvidence']['words'][0]['bbox'],[10,10,30,20])
                self.assertFalse(first['wordEvidence']['normalizationVerified'])
                self.assertFalse(first['cacheHit']);self.assertFalse(second['cacheHit'])
                self.assertTrue(ocr(b'identical-pixels',Path(tmp),150,6)['cacheHit'])
                self.assertEqual(invoke.call_count,2)
                with patch('measure.SPATIAL_HASH','changed-parser-identity'):
                    changed=ocr(b'identical-pixels',Path(tmp),150,6)
                    self.assertFalse(changed['cacheHit'])
                    self.assertEqual(invoke.call_count,3)

if __name__=='__main__':unittest.main()
