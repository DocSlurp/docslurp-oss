#!/usr/bin/env python3
"""Single-raster local inference boundary for the opt-in worker layout adapter."""
import argparse
import hashlib
import json
from pathlib import Path
import time
from adapters import load_detector
from fingerprints import describe_region


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--model',choices=['heron','ppv3','pp-small','pp-small-onnx'],default='heron')
    parser.add_argument('--device',default='cpu')
    parser.add_argument('--precision',choices=['fp32','fp16'],default='fp32')
    parser.add_argument('--threads',type=int,default=4)
    parser.add_argument('--threshold',type=float,default=.3)
    parser.add_argument('--model-path')
    parser.add_argument('--onnx-path')
    parser.add_argument('--revision')
    args=parser.parse_args()
    from PIL import Image
    # Local mode must never silently fetch weights during an ingestion request.
    if args.model=='pp-small' and not args.model_path: parser.error('pp-small inference requires --model-path to a cached Paddle model directory')
    detector=load_detector(args.model,device=args.device,precision=args.precision,threads=args.threads,
        model_path=args.model_path,onnx_path=args.onnx_path,revision=args.revision,local_files_only=True)
    data=args.image.read_bytes()
    import io
    with Image.open(io.BytesIO(data)) as opened: image=opened.convert('RGB')
    start=time.perf_counter(); predictions,timings=detector.predict([image],args.threshold)
    regions=[]
    for region in predictions[0]:
        regions.append(dict(label=region['label'],rawLabel=region['raw_label'],confidence=region['confidence'],bbox=region['bbox'],**describe_region(image,region)))
    result={'schemaVersion':1,'model':{'id':detector.metadata['id'],'revision':detector.metadata['revision']},
        'device':args.device,'image':{'width':image.width,'height':image.height,'sha256':hashlib.sha256(data).hexdigest()},
        'coordinateSpace':'normalized-source','supportedLabels':detector.supported_labels,'regions':regions,
        'diagnostics':{'timings':timings,'elapsedMs':1000*(time.perf_counter()-start),'storedPixelOrientation':True,'coverageKindSemantics':'bbox area heuristic for visual regions: full-page>=0.90; half-page>=0.40; not a semantic image classifier'}}
    args.output.write_text(json.dumps(result)+'\n')


if __name__=='__main__': main()
