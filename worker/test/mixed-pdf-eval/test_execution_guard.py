import os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from execution_guard import ExecutionRefused,REPO_FIXTURE_ROOT,assert_eval_execution
from measure import ocr

class ExecutionGuardTests(unittest.TestCase):
    def test_refuses_the_service_profile_even_for_fixtures(self):
        for profile in ['service',' Service ']:
            with self.assertRaisesRegex(ExecutionRefused,'service-profile'):
                assert_eval_execution(REPO_FIXTURE_ROOT/'generate.py',env={'DOCSLURP_SERVICE_PROFILE':profile})
        assert_eval_execution(REPO_FIXTURE_ROOT/'generate.py',env={'DOCSLURP_SERVICE_PROFILE':'self-hosted'})
        assert_eval_execution(REPO_FIXTURE_ROOT/'generate.py',env={})

    def test_ocr_refuses_under_the_service_profile_before_running_anything(self):
        with tempfile.TemporaryDirectory(prefix='mixed-guard-',dir=os.environ.get('TMPDIR','/tmp')) as tmp:
            with patch.dict(os.environ,{'DOCSLURP_SERVICE_PROFILE':'service'}),patch('measure.run_ocr_cli') as cli:
                with self.assertRaisesRegex(ExecutionRefused,'service-profile'):
                    ocr(b'pixels',Path(tmp),150,6,use_cache=False)
                cli.assert_not_called()

    def test_refuses_inputs_outside_the_declared_data_roots(self):
        with tempfile.TemporaryDirectory(prefix='mixed-guard-',dir=os.environ.get('TMPDIR','/tmp')) as tmp:
            root=Path(tmp)/'evals';root.mkdir();outside=Path(tmp)/'customer';outside.mkdir()
            (outside/'upload.pdf').write_bytes(b'%PDF-1.4')
            env={'MIXED_EVAL_DATA_ROOTS':str(root)}
            assert_eval_execution(root,root/'dataset'/'case.pdf',env=env)
            for bad in [outside/'upload.pdf',root/'..'/'customer'/'upload.pdf',Path('/etc/passwd')]:
                with self.assertRaisesRegex(ExecutionRefused,'outside-data-roots',msg=str(bad)):
                    assert_eval_execution(bad,env=env)
            # A link inside a data root that points out of it is refused too.
            (root/'link.pdf').symlink_to(outside/'upload.pdf')
            with self.assertRaisesRegex(ExecutionRefused,'outside-data-roots'):
                assert_eval_execution(root/'link.pdf',env=env)
            # Without MIXED_EVAL_DATA_ROOTS only the harness's own directory is allowed.
            with self.assertRaisesRegex(ExecutionRefused,'outside-data-roots'):
                assert_eval_execution(root,env={})
            with self.assertRaisesRegex(ExecutionRefused,'not-absolute'):
                assert_eval_execution(root,env={'MIXED_EVAL_DATA_ROOTS':'relative/dir'})

if __name__=='__main__':unittest.main()
