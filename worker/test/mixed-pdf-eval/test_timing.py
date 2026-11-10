import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from measure import ocr

class TimingTests(unittest.TestCase):
    def test_repeated_pixels_reexecute_when_cache_disabled(self):
        os.environ.setdefault('TMPDIR','/home/dan/tmp/agents')
        def fake_cli(argv,env):
            # The CLI runs under the parser sandbox and writes its docslurp-ocr@1 result.
            self.assertTrue(argv[0].endswith('parser-sandbox.sh'))
            self.assertIn(env['DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS'],argv[argv.index('--output')+1])
            Path(argv[argv.index('--output')+1]).write_text(json.dumps({'frames':[{'text':'A word','meanConfidence':0.9,
                'lines':[{'text':'A word','confidence':0.9,'box':[0,0,1,1]}]}]}))
            return .1
        with tempfile.TemporaryDirectory(prefix='mixed-cache-test-',dir=os.environ['TMPDIR']) as tmp:
            with patch('measure.ocr_runtime',return_value=('/venv/bin/python3','/models')), \
                 patch('measure.run_ocr_cli',side_effect=fake_cli) as cli:
                first=ocr(b'identical-pixels',Path(tmp),150,6,use_cache=False)
                second=ocr(b'identical-pixels',Path(tmp),150,6,use_cache=False)
                self.assertEqual(cli.call_count,2)
                self.assertFalse(first['cacheHit']);self.assertFalse(second['cacheHit'])
                self.assertEqual((first['text'],first['confidence'],first['lowConfidenceWordShare']),('A word',90.0,0.0))
                self.assertTrue(ocr(b'identical-pixels',Path(tmp),150,6)['cacheHit'])
                self.assertEqual(cli.call_count,2)

    def test_refuses_without_the_ocr_runtime(self):
        with tempfile.TemporaryDirectory(prefix='mixed-cache-test-',dir=os.environ.get('TMPDIR','/tmp')) as tmp:
            with patch.dict(os.environ,{'DOCSLURP_OCR_PYTHON':'','DOCSLURP_OCR_MODEL_DIR':''}):
                with self.assertRaisesRegex(RuntimeError,'ocr-runtime-missing'):
                    ocr(b'pixels',Path(tmp),150,6,use_cache=False)

if __name__=='__main__':unittest.main()
