"""Executed only in the final guest environment; never on customer bytes."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

root = Path('/opt/docslurp/layout')
os.environ.clear()
os.environ.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/job', TMPDIR='/job',
    HF_HOME=str(root / 'assets/cache'), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
    CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
sys.path.insert(0, str(root / 'runtime'))
import infer
from asset_identity import verify_asset_bundle

provenance = json.loads((root / 'assets/model.provenance.json').read_text())
revision = provenance['source_revision']
arguments = ['--model', 'pp-small-onnx', '--device', 'cpu', '--precision', 'fp32',
             '--threads', '2', '--threshold', '0.3', '--visual-classifier', 'none',
             '--onnx-path', str(root / 'assets/model.onnx'), '--revision', revision]
parser = argparse.ArgumentParser()
infer.add_detector_arguments(parser)
args = parser.parse_args(arguments)
# Mirror the VM entrypoint's imports before detector creation so runtime_versions
# includes Pillow; importing it afterwards changes the profile identity.
from PIL import Image, features
assert features.check('webp'), 'Pillow WebP support is required'
files = [{'path': str(p.relative_to(root / 'assets')),
          'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
         for p in sorted((root / 'assets').rglob('*')) if p.is_file()]
bundle = verify_asset_bundle(root / 'assets', files)
detector = infer.create_detector(args, verified_artifact_sha256=bundle)
manifest = {'schemaVersion': 1, 'model': 'pp-small-onnx',
            'modelId': 'PaddlePaddle/PP-DocLayout-S', 'revision': revision,
            'artifactSha256': bundle,
            'graphSha256': hashlib.sha256((root / 'assets/model.onnx').read_bytes()).hexdigest(),
            'inferenceProfileSha256': infer.inference_profile_sha256(detector, 'cpu', args.threshold),
            'arguments': arguments, 'files': files, 'license': 'Apache-2.0',
            'python': platform.python_version(), 'detectorMetadata': detector.metadata,
            'installedDistributions': sorted([{'name': d.metadata['Name'], 'version': d.version}
                                             for d in importlib.metadata.distributions()], key=lambda d: d['name'].lower()),
            'systemPackages': subprocess.check_output(['dpkg-query', '-W', '-f=${Package}\t${Version}\n'], text=True).splitlines()}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
