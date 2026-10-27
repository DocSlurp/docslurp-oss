import copy,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from measure import ocr,validate_ocr_record

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
                validate_ocr_record(first,first['ocrIdentity'])
                mutations=[lambda r:r.update(rawWordTsvHash='0'*64),
                           lambda r:r.update(text='changed candidate'),
                           lambda r:r['wordEvidence']['words'][0].update(text='changed raw word'),
                           lambda r:r.update(confidence=100),
                           lambda r:r.update(lowConfidenceWordShare=1),
                           lambda r:r['ocrIdentity'].update(psm=3),
                           lambda r:r.update(imageHash='0'*64)]
                for mutate in mutations:
                    broken=copy.deepcopy(first);mutate(broken)
                    with self.assertRaises(RuntimeError):validate_ocr_record(broken,first['ocrIdentity'])
                for field in ['seconds','evidenceParseSeconds']:
                    for bad in [-9,float('nan'),float('inf'),None,'bad',True]:
                        broken=copy.deepcopy(first);broken[field]=bad
                        with self.assertRaises(RuntimeError):validate_ocr_record(broken,first['ocrIdentity'])
                for change in [dict(evidenceParseSeconds=first['seconds']+1),dict(execution=None),
                               dict(execution={**first['execution'],'capturedAt':'2026-10-27T00:00:00'}),
                               dict(execution={**first['execution'],'workers':'0'})]:
                    broken=copy.deepcopy(first);broken.update(change)
                    with self.assertRaises(RuntimeError):validate_ocr_record(broken,first['ocrIdentity'])
                # A real cache lookup rejects a corrupt record without invoking
                # OCR or overwriting the retained failure.
                record_path=next(Path(tmp).glob('*.json'))
                original=record_path.read_bytes();broken=json.loads(original)
                broken['rawWordTsvHash']='0'*64;record_path.write_text(json.dumps(broken))
                with self.assertRaisesRegex(RuntimeError,'ocr-cache-raw-hash-mismatch'):
                    ocr(b'identical-pixels',Path(tmp),150,6)
                self.assertEqual(invoke.call_count,2)
                self.assertEqual(json.loads(record_path.read_text())['rawWordTsvHash'],'0'*64)
                record_path.write_bytes(original)
                with patch('measure.SPATIAL_HASH','changed-parser-identity'):
                    changed=ocr(b'identical-pixels',Path(tmp),150,6)
                    self.assertFalse(changed['cacheHit'])
                    self.assertEqual(invoke.call_count,3)

if __name__=='__main__':unittest.main()
