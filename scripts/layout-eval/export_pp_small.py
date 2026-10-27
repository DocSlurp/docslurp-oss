#!/usr/bin/env python3
"""Export ONLY official Apache-2.0 PP-DocLayout-S weights to an audited local ONNX graph.

Requires huggingface_hub, paddlepaddle and paddle2onnx in a dedicated environment.
Downloads ~5 MB model files; Python/runtime dependencies are much larger. Source
revision, file hashes, command and resulting graph hash are retained next to graph.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import sys
import time
import re
import importlib.metadata

SOURCE_LOCK = Path(__file__).resolve().parents[1] / 'document-vm/source-lock.json'


def verify_source(model_dir, revision, lock):
    """Verify approved bytes BEFORE any native converter sees the source."""
    if lock['source'] != 'PaddlePaddle/PP-DocLayout-S' or lock['source_revision'] != revision:
        raise ValueError('Source revision is not approved by source lock')
    if model_dir.is_symlink(): raise ValueError('Source directory must not be a symlink')
    expected = lock['source_files_sha256']
    files = {p.name for p in model_dir.iterdir() if p.name != '.cache'}
    if files != set(expected): raise ValueError('Source file set differs from approved lock')
    for name, digest in expected.items():
        path = model_dir / name
        if Path(name).name != name or path.is_symlink() or not path.is_file():
            raise ValueError('Invalid source asset')
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Source file differs from approved lock: ' + name)
    return dict(expected)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--revision',required=True,help='Immutable 40-character official HF commit')
    parser.add_argument('--download',action='store_true',help='Explicitly allow downloading official upstream weights')
    args=parser.parse_args()
    revision=args.revision
    if not re.fullmatch('[0-9a-f]{40}', revision): raise ValueError('Immutable HF source revision required')
    lock = json.loads(SOURCE_LOCK.read_text())
    if lock['source_revision'] != revision: raise ValueError('Revision differs from approved source lock')
    if args.download:
        from huggingface_hub import HfApi,snapshot_download
        revision=HfApi().model_info('PaddlePaddle/PP-DocLayout-S',revision=revision).sha
        snapshot_download('PaddlePaddle/PP-DocLayout-S',revision=revision,local_dir=args.model_dir,
                          allow_patterns=['inference.*','config.json','README.md'])
    hashes = verify_source(args.model_dir, revision, lock)
    if args.output.exists(): raise ValueError('Refuse to overwrite existing model graph')
    source=args.model_dir/'inference.json'
    if not source.exists(): source=args.model_dir/'inference.pdmodel'
    if not source.exists() or not (args.model_dir/'inference.pdiparams').exists(): raise ValueError('Missing official Paddle model files')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    executable=shutil.which('paddle2onnx') or str(Path(sys.executable).parent/'paddle2onnx')
    command=[executable,'--model_dir',str(args.model_dir),'--model_filename',source.name,
             '--params_filename','inference.pdiparams','--save_file',str(args.output),'--opset_version','17',
             '--enable_onnx_checker','True','--enable_auto_update_opset','False','--optimize_tool','None']
    started=time.time(); subprocess.run(command,check=True)
    verify_source(args.model_dir, revision, lock)
    graph_sha256=hashlib.sha256(args.output.read_bytes()).hexdigest()
    if graph_sha256 != lock['graph_sha256']: raise ValueError('Exported graph differs from approved lock')
    metadata={'source':'PaddlePaddle/PP-DocLayout-S','source_revision':revision,'license':'Apache-2.0',
              'source_files_sha256':hashes,'command':command,'export_seconds':time.time()-started,
              'exporter_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'python':sys.version,'export_packages':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()},
              'graph_sha256':graph_sha256}
    args.output.with_suffix('.provenance.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps(metadata))


if __name__=='__main__': main()
