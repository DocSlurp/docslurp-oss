"""CPU-only, offline, digest-pinned image entrypoint. Never run on the worker host."""
import json
import os
from pathlib import Path
import resource
import sys

ROOT = Path('/opt/docslurp/layout')
MAX_JSON = 10 * 1024 * 1024


def main(request, root=ROOT, input_path=Path('/job/input'), output_path=Path('/job/output')):
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_JSON, MAX_JSON))
    resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
    # Clear image environment before importing runtimes, not just host variables.
    os.environ.clear()
    os.environ.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/job', TMPDIR='/job',
        HF_HOME=str(root / 'assets/cache'), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
        CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
    sys.path.insert(0, str(root / 'runtime'))
    from asset_identity import SHA256, verify_asset_bundle
    if not isinstance(request, dict) or request.get('device') != 'cpu':
        raise ValueError('CUDA is unavailable behind the VM boundary')
    for key in ('modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256'):
        value = request.get(key)
        if not isinstance(value, str) or not value or len(value) > 4096:
            raise ValueError('Missing required request identity: ' + key)
        if key == 'revision' and value == 'unknown': raise ValueError('Model revision must be pinned')
        if key.endswith('Sha256') and not SHA256.fullmatch(value):
            raise ValueError('Invalid request identity hash: ' + key)
    manifest_path = root / 'manifest.json'
    if manifest_path.stat().st_size > 65536: raise ValueError('Oversized model manifest')
    manifest = json.loads(manifest_path.read_text())
    for key in ('modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256'):
        if manifest.get(key) != request[key]: raise ValueError('Model manifest identity mismatch: ' + key)
    if manifest.get('model') != request.get('model'): raise ValueError('Unsupported model in this VM image')
    bundle = verify_asset_bundle(root / 'assets', manifest['files'])
    if manifest['artifactSha256'] != bundle: raise ValueError('Manifest bundle identity mismatch')
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 16000000
    if input_path.stat().st_size > 25 * 1024 * 1024: raise ValueError('Oversized layout input')
    data = input_path.read_bytes()
    import io
    with Image.open(io.BytesIO(data)) as image:
        if image.width > 4096 or image.height > 4096 or image.width * image.height > 16000000 or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Invalid image dimensions or animation')
    import argparse
    import infer
    parser = argparse.ArgumentParser()
    infer.add_detector_arguments(parser)
    args = parser.parse_args(manifest['arguments'])
    if args.device != 'cpu' or args.model != request['model']: raise ValueError('Manifest must select requested CPU model')
    for key in ('model_path', 'onnx_path', 'classifier_model_path', 'orientation_onnx_path'):
        value = getattr(args, key, None)
        if value:
            location = Path(value).resolve(strict=True)
            if not location.is_relative_to((root / 'assets').resolve(strict=True)):
                raise ValueError('Model must be an offline image asset')
    if not args.model_path and not args.onnx_path: raise ValueError('An offline local model asset is required')
    detector = infer.create_detector(args, verified_artifact_sha256=bundle)
    result = infer.build_result(detector, data, 'cpu', args.threshold)
    if result['model']['id'] != manifest['modelId'] or result['model']['revision'] != manifest['revision']:
        raise ValueError('Runtime model identity mismatch')
    if result['model'].get('artifactSha256') != bundle or result.get('inferenceProfileSha256') != manifest['inferenceProfileSha256']:
        raise ValueError('Runtime model or profile hash mismatch')
    output_path.write_bytes(infer.encode_result(result))


if __name__ == '__main__':
    main(json.loads(sys.argv[1]))
