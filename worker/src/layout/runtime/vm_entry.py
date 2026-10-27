"""CPU-only, offline, digest-pinned image entrypoint. Never run on the worker host."""
import hashlib
import json
import os
from pathlib import Path
import resource
import sys

ROOT = Path('/opt/docslurp/layout')
MAX_JSON = 10 * 1024 * 1024
resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_JSON, MAX_JSON))
resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
# Clear image environment before importing runtimes, not just host-supplied variables.
os.environ.clear()
os.environ.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/job', TMPDIR='/job',
    HF_HOME=str(ROOT / 'assets/cache'), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
    CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
request = json.loads(sys.argv[1])
if request.get('device') != 'cpu': raise ValueError('CUDA is unavailable behind the VM boundary')
manifest_path = ROOT / 'manifest.json'
if manifest_path.stat().st_size > 65536: raise ValueError('Oversized model manifest')
manifest = json.loads(manifest_path.read_text())
for key in ('modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256'):
    expected = request.get(key)
    if expected and manifest.get(key) != expected: raise ValueError('Model manifest identity mismatch: ' + key)
if manifest.get('model') != request['model']: raise ValueError('Unsupported model in this VM image')
files = manifest['files']
if not files or len(files) > 128: raise ValueError('Invalid model file manifest')
for entry in files:
    location = (ROOT / 'assets' / entry['path']).resolve(strict=True)
    if not location.is_relative_to(ROOT / 'assets') or not location.is_file(): raise ValueError('Invalid model asset path')
    digest = hashlib.sha256()
    with location.open('rb') as handle:
        while chunk := handle.read(1024 * 1024): digest.update(chunk)
    if digest.hexdigest() != entry['sha256']: raise ValueError('Offline model asset hash mismatch')
from PIL import Image
Image.MAX_IMAGE_PIXELS = 16000000
# Validate before loading the model as well as inside build_result.
data = Path('/job/input').read_bytes()
import io
with Image.open(io.BytesIO(data)) as image:
    if image.width > 4096 or image.height > 4096 or image.width * image.height > 16000000 or getattr(image, 'n_frames', 1) != 1:
        raise ValueError('Invalid image dimensions or animation')
import argparse
sys.path.insert(0, str(ROOT / "runtime"))
import infer
parser = argparse.ArgumentParser()
infer.add_detector_arguments(parser)
args = parser.parse_args(manifest['arguments'])
if args.device != 'cpu' or args.model != request['model']: raise ValueError('Manifest must select requested CPU model')
for key in ('model_path', 'onnx_path', 'classifier_model_path', 'orientation_onnx_path'):
    value = getattr(args, key, None)
    if value:
        location = Path(value).resolve(strict=True)
        if not location.is_relative_to(ROOT / 'assets'): raise ValueError('Model must be an offline image asset')
if not args.model_path and not args.onnx_path: raise ValueError('An offline local model asset is required')
detector = infer.create_detector(args)
result = infer.build_result(detector, data, 'cpu', args.threshold)
if result['model']['id'] != manifest['modelId'] or result['model']['revision'] != manifest['revision']:
    raise ValueError('Runtime model identity mismatch')
if result['model'].get('artifactSha256') != manifest['artifactSha256'] or result.get('inferenceProfileSha256') != manifest['inferenceProfileSha256']:
    raise ValueError('Runtime model or profile hash mismatch')
Path('/job/output').write_bytes(infer.encode_result(result))
