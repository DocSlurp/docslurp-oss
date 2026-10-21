#!/usr/bin/env python3
"""Calibrate PP-DocLayout-S ONNX INT8 on train image pixels by default.

No labels are read or passed to ORT calibration. Holdout is forbidden. This is an
experiment, not a presumption that INT8 will be faster or preserve accuracy.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--manifest',required=True,type=Path)
    parser.add_argument('--limit',type=int,default=32)
    parser.add_argument('--split',choices=['train','dev'],default='train')
    parser.add_argument('--activation-type',choices=['uint8','int8'],default='uint8')
    parser.add_argument('--weight-type',choices=['uint8','int8'],default='int8')
    parser.add_argument('--reduce-range',action='store_true')
    args=parser.parse_args()
    if args.activation_type=='int8' and args.weight_type=='uint8': parser.error('S8U8 is not a supported CPU quantization combination')
    if args.output.exists(): raise ValueError('Refuse to overwrite an existing graph')
    from onnxruntime.quantization import CalibrationDataReader,QuantFormat,QuantType,quantize_static
    import numpy as np
    import cv2
    from PIL import Image
    from benchmark import read_manifest
    rows=[r for r in read_manifest(args.manifest) if r['split']==args.split]
    random.Random(417).shuffle(rows); rows=rows[:args.limit]
    if not rows: raise ValueError('No train/dev images for calibration')
    class Images(CalibrationDataReader):
        def __init__(self): self.rows=iter(rows)
        def get_next(self):
            row=next(self.rows,None)
            if row is None: return None
            with Image.open(args.manifest.parent/row['image_path']) as im:
                width,height=im.size; data=cv2.resize(np.asarray(im.convert('RGB')),(480,480),interpolation=cv2.INTER_CUBIC).astype(np.float32)/255.
            data=(data-np.array([.485,.456,.406],dtype=np.float32))/np.array([.229,.224,.225],dtype=np.float32)
            return {'image':data.transpose(2,0,1)[None], 'scale_factor':np.array([[480/height,480/width]],dtype=np.float32)}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    started=time.time()
    types={'uint8':QuantType.QUInt8,'int8':QuantType.QInt8}
    quantize_static(str(args.model),str(args.output),Images(),quant_format=QuantFormat.QDQ,
                    activation_type=types[args.activation_type],weight_type=types[args.weight_type],
                    reduce_range=args.reduce_range,per_channel=True,op_types_to_quantize=['Conv'])
    metadata={'source_sha256':hashlib.sha256(args.model.read_bytes()).hexdigest(),
              'graph_sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),
              'calibration_page_ids':[r['id'] for r in rows],'calibration_manifest_sha256':hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
              'split_policy':args.split+' image pixels only; no reference labels','quantization':{'format':'QDQ','ops':['Conv'],'per_channel':True,'activation':args.activation_type,'weight':args.weight_type,'reduce_range':args.reduce_range},
              'elapsed_seconds':time.time()-started}
    args.output.with_suffix('.provenance.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps(metadata))


if __name__=='__main__': main()
