import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from render_predictions import manifest_scope,validate_prediction_scope


class OverlayAuthorizationTests(unittest.TestCase):
    def fixture(self,root,rows):
        manifest=root/'manifest.jsonl';manifest.write_text(''.join(json.dumps(r)+'\n' for r in rows))
        freeze=root/'freeze.json';freeze.write_text(json.dumps({'schema':'layout-finalists-freeze-v1','no_retuning_after_holdout':True,
            'createdAt':'2026-10-21T02:00:00+00:00','datasets':{'test':{'holdout_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'integrity_passed':True}}}))
        return manifest,freeze

    def test_holdout_flag_requires_freeze_and_hash_match(self):
        with tempfile.TemporaryDirectory(prefix='overlay-freeze-',dir='/home/dan/tmp/agents') as temp:
            root=Path(temp);manifest,freeze=self.fixture(root,[{'id':'a','split':'holdout'}])
            with self.assertRaisesRegex(ValueError,'requires --finalist-freeze'):manifest_scope(manifest,True)
            with self.assertRaisesRegex(ValueError,'dev-only'):manifest_scope(manifest)
            rows,scope=manifest_scope(manifest,True,freeze)
            self.assertEqual(scope['split'],'holdout');self.assertEqual(scope['finalist_freeze']['dataset'],'test')
            manifest.write_text(manifest.read_text()+'\n')
            with self.assertRaisesRegex(ValueError,'hash'):manifest_scope(manifest,True,freeze)

    def test_every_row_must_match_even_duplicate_id(self):
        with tempfile.TemporaryDirectory(prefix='overlay-mixed-',dir='/home/dan/tmp/agents') as temp:
            root=Path(temp);manifest,freeze=self.fixture(root,[{'id':'a','split':'holdout'},{'id':'a','split':'dev'}])
            with self.assertRaisesRegex(ValueError,'holdout-only'):manifest_scope(manifest,True,freeze)
            with self.assertRaisesRegex(ValueError,'dev-only'):manifest_scope(manifest)

    def test_dev_default_and_explicit_flag_policy(self):
        with tempfile.TemporaryDirectory(prefix='overlay-dev-',dir='/home/dan/tmp/agents') as temp:
            root=Path(temp);manifest,freeze=self.fixture(root,[{'id':'a','split':'dev'}])
            rows,scope=manifest_scope(manifest);self.assertEqual(scope['split'],'dev')
            self.assertIsNone(scope['finalist_freeze'])
            with self.assertRaisesRegex(ValueError,'explicit'):manifest_scope(manifest,False,freeze)

    def test_holdout_predictions_must_finish_and_postdate_freeze(self):
        with tempfile.TemporaryDirectory(prefix='overlay-done-',dir='/home/dan/tmp/agents') as temp:
            root=Path(temp);manifest,freeze=self.fixture(root,[{'id':'a','split':'holdout'}])
            _,scope=manifest_scope(manifest,True,freeze);summary=root/'summary.json'
            metadata={'split':'holdout','started_unix':1761015600}
            with self.assertRaisesRegex(ValueError,'completed'):validate_prediction_scope(metadata,summary,scope)
            summary.write_text('{}')
            with self.assertRaisesRegex(ValueError,'predates'):validate_prediction_scope(metadata,summary,scope)
            metadata['started_unix']=1792555200
            validate_prediction_scope(metadata,summary,scope)


if __name__=='__main__':unittest.main()
