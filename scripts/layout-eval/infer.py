#!/usr/bin/env python3
"""Cached-only single-raster inference; shared by cold CLI and warm loopback server."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import time
from adapters import load_detector
from fingerprints import describe_region

MAX_INPUT_BYTES=25*1024*1024
MAX_OUTPUT_BYTES=10*1024*1024


def add_detector_arguments(parser):
    parser.add_argument('--model',choices=['heron','ppv3','pp-small','pp-small-onnx'],default='heron')
    parser.add_argument('--device',choices=['cpu','cuda'],default='cpu')
    parser.add_argument('--precision',choices=['fp32','fp16'],default='fp32')
    parser.add_argument('--threads',type=int,default=4)
    parser.add_argument('--processor',choices=['slow','fast'],default='slow')
    parser.add_argument('--threshold',type=float,default=.3)
    parser.add_argument('--model-path')
    parser.add_argument('--onnx-path')
    parser.add_argument('--revision')
    parser.add_argument('--visual-classifier',choices=['none','siglip2'],default='none')
    parser.add_argument('--classifier-model-path')
    parser.add_argument('--classifier-revision')


def create_detector(args):
    if args.model=='pp-small' and not args.model_path:
        raise ValueError('pp-small inference requires --model-path to a cached Paddle model directory')
    if args.threads<1 or not 0<=args.threshold<=1:
        raise ValueError('Invalid thread count or confidence threshold')
    detector=load_detector(args.model,device=args.device,precision=args.precision,threads=args.threads,
        model_path=args.model_path,onnx_path=args.onnx_path,revision=args.revision,local_files_only=True,processor=args.processor)
    if args.visual_classifier=='siglip2':
        from visual_classifier import VisualCropClassifier,VisualClassifierDetector
        classifier=VisualCropClassifier(device=args.device,precision=args.precision,threads=args.threads,
            model_path=args.classifier_model_path,revision=args.classifier_revision,local_files_only=True)
        detector=VisualClassifierDetector(detector,classifier)
    return detector


def build_result(detector,data,device,threshold=.3):
    from PIL import Image
    if not data or len(data)>MAX_INPUT_BYTES: raise ValueError('Image payload must be between 1 byte and 25 MiB')
    decode_start=time.perf_counter()
    with Image.open(io.BytesIO(data)) as opened:
        if getattr(opened,'n_frames',1)!=1 or opened.width*opened.height>100_000_000:
            raise ValueError('Only single raster images up to 100 million pixels are supported')
        # Preserve stored pixels, with no implicit EXIF orientation transform.
        image=opened.convert('RGB')
    start=time.perf_counter(); predictions,timings=detector.predict([image],threshold)
    if len(predictions)!=1: raise ValueError('Detector result count mismatch')
    regions=[]
    for region in predictions[0]:
        entry=dict(label=region['label'],rawLabel=region['raw_label'],confidence=region['confidence'],bbox=region['bbox'])
        if 'classification' in region: entry['classification']=region['classification']
        if 'detector_label' in region: entry['detectorLabel']=region['detector_label']
        entry.update(describe_region(image,region)); regions.append(entry)
    return {'schemaVersion':1,'model':{'id':detector.metadata['id'],'revision':detector.metadata['revision'],**({'artifactSha256':detector.metadata['graph_sha256']} if detector.metadata.get('graph_sha256') else {})},
        'device':device,'image':{'width':image.width,'height':image.height,'sha256':hashlib.sha256(data).hexdigest()},
        'coordinateSpace':'normalized-source','supportedLabels':detector.supported_labels,'regions':regions,
        'diagnostics':{'timings':timings,'decodeMs':1000*(start-decode_start),'elapsedMs':1000*(time.perf_counter()-decode_start),
          'storedPixelOrientation':True,'visualClassifier':detector.metadata.get('visual_classifier'),
          'coverageKindSemantics':'bbox area heuristic for visual regions: full-page>=0.90; half-page>=0.40; not a semantic image classifier'}}


def encode_result(result):
    output=json.dumps(result,allow_nan=False).encode()+b'\n'
    if len(output)>MAX_OUTPUT_BYTES: raise ValueError('Layout output exceeds 10 MiB')
    return output


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    add_detector_arguments(parser); args=parser.parse_args()
    if args.image.stat().st_size>MAX_INPUT_BYTES: parser.error('Image payload exceeds 25 MiB')
    detector=create_detector(args)
    args.output.write_bytes(encode_result(build_result(detector,args.image.read_bytes(),args.device,args.threshold)))


if __name__=='__main__': main()
