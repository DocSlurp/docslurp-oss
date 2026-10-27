#!/usr/bin/env python3
"""Prepare a minimal build context from an audited export, without downloading.

Use export_pp_small.py with an immutable official HF revision first. All model
assets stay outside Git. Dependencies are downloaded/hashed separately by build.sh.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--graph', type=Path, required=True)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--license', type=Path, required=True)
parser.add_argument('--context', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
provenance = json.loads(args.graph.with_suffix('.provenance.json').read_text())
lock = json.loads(Path(__file__).with_name('source-lock.json').read_text())
for key in ('source', 'source_revision', 'license', 'source_files_sha256', 'graph_sha256'):
    if provenance[key] != lock[key]: raise ValueError('Export differs from approved source lock: ' + key)
if hashlib.sha256(args.license.read_bytes()).hexdigest() != lock['license_text_sha256']:
    raise ValueError('Expected canonical Apache-2.0 license text')
if provenance['source'] != 'PaddlePaddle/PP-DocLayout-S' or provenance['license'] != 'Apache-2.0':
    raise ValueError('Only official Apache-2.0 PP-DocLayout-S is supported')
if not re.fullmatch('[0-9a-f]{40}', provenance['source_revision']):
    raise ValueError('Immutable HF commit required')
if hashlib.sha256(args.graph.read_bytes()).hexdigest() != provenance['graph_sha256']:
    raise ValueError('Graph differs from export provenance')
for name, expected in provenance['source_files_sha256'].items():
    if Path(name).name != name or hashlib.sha256((args.source / name).read_bytes()).hexdigest() != expected:
        raise ValueError('Source differs from export provenance')
args.context.mkdir(parents=True, exist_ok=False)
assets = args.context / 'assets'
assets.mkdir()
shutil.copytree(repo / 'worker/src/layout/runtime', args.context / 'runtime', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
shutil.copy2(args.graph, assets / 'model.onnx')
# Keep nondeterministic elapsed time and machine-specific paths in external export
# evidence, not in the identity of an otherwise identical reproducible bundle.
canonical = {key: value for key, value in provenance.items() if key not in ('command', 'export_seconds')}
canonical['command'] = ['paddle2onnx', '--model_dir', 'source', '--model_filename', 'inference.json',
    '--params_filename', 'inference.pdiparams', '--save_file', 'model.onnx', '--opset_version', '17',
    '--enable_onnx_checker', 'True', '--enable_auto_update_opset', 'False', '--optimize_tool', 'None']
(assets / 'model.provenance.json').write_text(json.dumps(canonical, indent=2, sort_keys=True) + '\n')
shutil.copy2(args.license, assets / 'LICENSE.Apache-2.0')
shutil.copytree(args.source, assets / 'source', ignore=shutil.ignore_patterns('.cache', '.git'))
shutil.copy2(repo / 'worker/Dockerfile.document-vm', args.context / 'Dockerfile')
shutil.copy2(Path(__file__).with_name('seal.py'), args.context / 'seal.py')
