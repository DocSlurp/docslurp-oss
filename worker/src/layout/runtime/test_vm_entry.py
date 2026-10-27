"""Offline entrypoint contracts: synthetic PNG and stubbed model backends only."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from PIL import Image

from asset_identity import canonical_bundle_sha256, verify_asset_bundle
import infer
import vm_entry

MODELS = {
    'heron': 'docling-project/docling-layout-heron',
    'heron-custom': 'docslurp/heron-custom',
    'ppv3': 'PaddlePaddle/PP-DocLayoutV3_safetensors',
    'pp-small': 'PaddlePaddle/PP-DocLayout-S',
    'pp-small-onnx': 'PaddlePaddle/PP-DocLayout-S',
}


class EntryIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='layout-entry-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        (self.assets / 'weights.bin').write_bytes(b'synthetic model stand-in; no inference')
        (self.assets / 'config.json').write_text('{}')
        self.files = [{'path': f.name, 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()} for f in self.assets.iterdir()]
        self.bundle = canonical_bundle_sha256(self.files)
        self.input = self.root / 'input.png'
        self.output = self.root / 'output.json'
        Image.new('RGB', (3, 4), 'white').save(self.input)
        self.addCleanup(patch.stopall)
        patch.dict(os.environ).start()
        patch.object(sys, 'path', list(sys.path)).start()
        patch.object(vm_entry.resource, 'setrlimit').start()
        self.load = patch.object(infer, 'load_detector', side_effect=self.detector).start()

    def detector(self, model, **kwargs):
        # Match the original issue: Transformers/native Paddle have no graph hash.
        metadata = {'id': MODELS[model], 'revision': 'immutable-test-revision', 'runtime': model}
        if model == 'pp-small-onnx': metadata['graph_sha256'] = self.files[0]['sha256']
        return SimpleNamespace(metadata=metadata, supported_labels=[], predict=lambda images, threshold: ([[]], {}))

    def prepare(self, model='heron'):
        arguments = ['--model', model, '--device', 'cpu', '--revision', 'immutable-test-revision']
        arguments += ['--onnx-path', str(self.assets / 'weights.bin')] if model == 'pp-small-onnx' else ['--model-path', str(self.assets)]
        parser = argparse.ArgumentParser()
        infer.add_detector_arguments(parser)
        detector = infer.create_detector(parser.parse_args(arguments), verified_artifact_sha256=self.bundle)
        profile = infer.inference_profile_sha256(detector, 'cpu')
        manifest = {'model': model, 'modelId': MODELS[model], 'revision': 'immutable-test-revision',
                    'artifactSha256': self.bundle, 'inferenceProfileSha256': profile,
                    'files': self.files, 'arguments': arguments}
        (self.root / 'manifest.json').write_text(json.dumps(manifest))
        request = {key: manifest[key] for key in ('model', 'modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256')}
        request['device'] = 'cpu'
        return manifest, request

    def run_entry(self, request):
        vm_entry.main(request, root=self.root, input_path=self.input, output_path=self.output)

    def test_every_advertised_cpu_adapter_passes_actual_entrypoint_identity_flow(self):
        for model in MODELS:
            with self.subTest(model=model):
                manifest, request = self.prepare(model)
                self.run_entry(request)
                result = json.loads(self.output.read_text())
                self.assertEqual(result['model'], {'id': MODELS[model], 'revision': manifest['revision'], 'artifactSha256': self.bundle})
                self.assertEqual(result['inferenceProfileSha256'], manifest['inferenceProfileSha256'])
                self.assertEqual(result['image'], {'width': 3, 'height': 4, 'sha256': hashlib.sha256(self.input.read_bytes()).hexdigest()})
                self.assertEqual(result['diagnostics']['detectorMetadata']['artifact_sha256'], self.bundle)
                self.assertEqual(result['device'], 'cpu')

    def test_bundle_hash_is_canonical_and_covers_names_and_bytes(self):
        self.assertEqual(self.bundle, canonical_bundle_sha256(list(reversed(self.files))))
        encoded = json.dumps(sorted(self.files, key=lambda f: f['path']), sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(self.bundle, hashlib.sha256(b'docslurp-layout-bundle-v1\n' + encoded).hexdigest())
        renamed = [dict(self.files[0], path='renamed.bin'), self.files[1]]
        self.assertNotEqual(self.bundle, canonical_bundle_sha256(renamed))
        self.assertEqual(self.bundle, verify_asset_bundle(self.assets, self.files))

    def test_mutated_or_undeclared_assets_fail_before_model_load(self):
        _, request = self.prepare()
        self.load.reset_mock()
        (self.assets / 'weights.bin').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'): self.run_entry(request)
        self.load.assert_not_called()
        (self.assets / 'undeclared.bin').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, 'exactly every'): self.run_entry(request)
        self.load.assert_not_called()

    def test_missing_identity_is_not_optional(self):
        _, request = self.prepare()
        self.load.reset_mock()
        for key in ('modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256'):
            with self.subTest(key=key):
                missing = dict(request)
                del missing[key]
                with self.assertRaisesRegex(ValueError, 'required request identity'): self.run_entry(missing)
        self.load.assert_not_called()

    def test_consistent_but_forged_manifest_bundle_fails(self):
        manifest, request = self.prepare()
        manifest['artifactSha256'] = request['artifactSha256'] = 'a' * 64
        (self.root / 'manifest.json').write_text(json.dumps(manifest))
        self.load.reset_mock()
        with self.assertRaisesRegex(ValueError, 'bundle identity mismatch'): self.run_entry(request)
        self.load.assert_not_called()

    def test_actual_profile_mismatch_fails_without_output(self):
        manifest, request = self.prepare('pp-small')
        manifest['inferenceProfileSha256'] = request['inferenceProfileSha256'] = 'a' * 64
        (self.root / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'profile hash mismatch'): self.run_entry(request)
        self.assertFalse(self.output.exists())

    def test_rejects_duplicate_traversal_or_noncanonical_manifest_entries(self):
        for files in [self.files + [self.files[0]], [dict(self.files[0], path='../weights.bin')],
                      [dict(self.files[0], path='a//b')], [dict(self.files[0], sha256='unknown')]]:
            with self.subTest(files=files), self.assertRaises(ValueError): canonical_bundle_sha256(files)


if __name__ == '__main__': unittest.main()
