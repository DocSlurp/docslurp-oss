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


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--revision',default='main')
    parser.add_argument('--download',action='store_true',help='Explicitly allow downloading official upstream weights')
    args=parser.parse_args()
    revision=args.revision
    if args.download:
        from huggingface_hub import HfApi,snapshot_download
        revision=HfApi().model_info('PaddlePaddle/PP-DocLayout-S',revision=revision).sha
        snapshot_download('PaddlePaddle/PP-DocLayout-S',revision=revision,local_dir=args.model_dir,
                          allow_patterns=['inference.*','config.json','README.md'])
    if args.output.exists(): raise ValueError('Refuse to overwrite existing model graph')
    source=args.model_dir/'inference.json'
    if not source.exists(): source=args.model_dir/'inference.pdmodel'
    if not source.exists() or not (args.model_dir/'inference.pdiparams').exists(): raise ValueError('Missing official Paddle model files')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    executable=shutil.which('paddle2onnx') or str(Path(sys.executable).parent/'paddle2onnx')
    command=[executable,'--model_dir',str(args.model_dir),'--model_filename',source.name,
             '--params_filename','inference.pdiparams','--save_file',str(args.output),'--opset_version','17',
             '--enable_onnx_checker','True']
    started=time.time(); subprocess.run(command,check=True)
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in args.model_dir.glob('inference.*')}
    metadata={'source':'PaddlePaddle/PP-DocLayout-S','source_revision':revision,'license':'Apache-2.0',
              'source_files_sha256':hashes,'command':command,'export_seconds':time.time()-started,
              'graph_sha256':hashlib.sha256(args.output.read_bytes()).hexdigest()}
    args.output.with_suffix('.provenance.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps(metadata))


if __name__=='__main__': main()
