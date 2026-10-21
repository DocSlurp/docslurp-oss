#!/usr/bin/env python3
"""Cached-only single-raster inference; shared by cold CLI and warm loopback server."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import time
from adapters import load_detector
from fingerprints import describe_region

MAX_INPUT_BYTES=25*1024*1024
MAX_OUTPUT_BYTES=10*1024*1024


def add_detector_arguments(parser):
    parser.add_argument('--model',choices=['heron','heron-custom','ppv3','pp-small','pp-small-onnx'],default='heron')
    parser.add_argument('--device',choices=['cpu','cuda'],default='cpu')
    parser.add_argument('--precision',choices=['fp32','fp16'],default='fp32')
    parser.add_argument('--threads',type=int,default=4)
    parser.add_argument('--processor',choices=['slow','fast'],default='slow')
    parser.add_argument('--model-size',type=int)
    parser.add_argument('--orientation-onnx-path')
    parser.add_argument('--orientation-revision',default='unknown')
    parser.add_argument('--orientation-minimum-score',type=float,default=.75)
    parser.add_argument('--rectify-page',action='store_true')
    parser.add_argument('--rectify-max-edge',type=int,default=768)
    parser.add_argument('--threshold',type=float,default=.3)
    parser.add_argument('--model-path')
    parser.add_argument('--onnx-path')
    parser.add_argument('--revision')
    parser.add_argument('--visual-classifier',choices=['none','siglip2'],default='none')
    parser.add_argument('--classifier-model-path')
    parser.add_argument('--classifier-revision')


def create_detector(args):
    if args.model=='heron-custom' and not args.model_path:
        raise ValueError('heron-custom requires --model-path to a local safetensors checkpoint')
    if args.model=='pp-small' and not args.model_path:
        raise ValueError('pp-small inference requires --model-path to a cached Paddle model directory')
    if args.threads<1 or not 0<=args.threshold<=1:
        raise ValueError('Invalid thread count or confidence threshold')
    if args.model_size is not None:
        if args.model not in ('heron','heron-custom','ppv3') or not 32<=args.model_size<=2048 or args.model_size%32:
            raise ValueError('Model size requires Transformers detector, multiple of32 in32..2048')
    if not math.isfinite(args.orientation_minimum_score) or not 0<=args.orientation_minimum_score<=1:
        raise ValueError('Invalid orientation minimum score')
    if not 128<=args.rectify_max_edge<=4096:raise ValueError('Rectification probe edge must be128..4096')
    if args.orientation_onnx_path and not Path(args.orientation_onnx_path).is_file():
        raise ValueError('Orientation requires an existing local ONNX file')
    detector=load_detector(args.model,device=args.device,precision=args.precision,threads=args.threads,
        model_path=args.model_path,onnx_path=args.onnx_path,revision=args.revision,local_files_only=True,processor=args.processor,model_size=args.model_size)
    if args.visual_classifier=='siglip2':
        from visual_classifier import VisualCropClassifier,VisualClassifierDetector
        classifier=VisualCropClassifier(device=args.device,precision=args.precision,threads=args.threads,
            model_path=args.classifier_model_path,revision=args.classifier_revision,local_files_only=True)
        detector=VisualClassifierDetector(detector,classifier)
    artifact_hash=detector.metadata.get('graph_sha256')
    if args.orientation_onnx_path:
        from orientation import OnnxOrientation,OrientedDetector
        detector=OrientedDetector(detector,OnnxOrientation(args.orientation_onnx_path,threads=args.threads,
            minimum_score=args.orientation_minimum_score,revision=args.orientation_revision))
    if args.rectify_page:
        from rectification import RectifiedDetector
        detector=RectifiedDetector(detector,max_edge=args.rectify_max_edge)
    if artifact_hash:detector.metadata['graph_sha256']=artifact_hash
    return detector


def metadata_value(metadata,key):
    while isinstance(metadata,dict):
        if key in metadata:return metadata[key]
        metadata=metadata.get('detector')
    return None


def inference_profile_sha256(detector,device,threshold=.3):
    """Pin inference-affecting runtime configuration, independently of graph identity."""
    # Transformers adapters record this per-request measurement after predict().
    # It is diagnostic output, not configuration. Strip only this known field,
    # including nested detector wrappers; retain model-size/processor settings.
    def configuration(value):
        if isinstance(value,dict):
            return {key:configuration(item) for key,item in value.items() if key!='last_input_tensor_shape'}
        if isinstance(value,(list,tuple)):return [configuration(item) for item in value]
        return value
    profile={'contractVersion':1,'detectorMetadata':configuration(detector.metadata),'device':device,'threshold':threshold}
    encoded=json.dumps(profile,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


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
        box=region['bbox']
        if len(box)!=4 or not all(math.isfinite(v) and 0<=v<=1 for v in box) or box[0]>=box[2] or box[1]>=box[3]:
            raise ValueError('Detector returned invalid source geometry')
        if not math.isfinite(region['confidence']) or not 0<=region['confidence']<=1:
            raise ValueError('Detector returned invalid confidence')
        entry=dict(label=region['label'],rawLabel=region['raw_label'],confidence=region['confidence'],bbox=region['bbox'])
        if 'polygon' in region: entry['polygon']=region['polygon']
        if 'reading_order' in region: entry['readingOrder']=region['reading_order']
        if 'classification' in region: entry['classification']=region['classification']
        if 'detector_label' in region: entry['detectorLabel']=region['detector_label']
        entry.update(describe_region(image,region)); regions.append(entry)
    return {'schemaVersion':1,'inferenceProfileSha256':inference_profile_sha256(detector,device,threshold),'model':{'id':detector.metadata['id'],'revision':detector.metadata['revision'],**({'artifactSha256':detector.metadata['graph_sha256']} if detector.metadata.get('graph_sha256') else {})},
        'device':device,'image':{'width':image.width,'height':image.height,'sha256':hashlib.sha256(data).hexdigest()},
        'coordinateSpace':'normalized-source','supportedLabels':detector.supported_labels,'regions':regions,
        'diagnostics':{'timings':timings,'decodeMs':1000*(start-decode_start),'elapsedMs':1000*(time.perf_counter()-decode_start),
          'detectorMetadata':detector.metadata,'imageTransforms':getattr(detector,'last_image_metadata',[]),
          'storedPixelOrientation':True,'nativeReadingOrder':any('readingOrder' in region for region in regions),'visualClassifier':metadata_value(detector.metadata,'visual_classifier'),
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
    started=time.perf_counter();detector=create_detector(args);model_load_ms=1000*(time.perf_counter()-started)
    result=build_result(detector,args.image.read_bytes(),args.device,args.threshold)
    result['diagnostics'].update(modelLoadMs=model_load_ms,execution='cold-cli')
    args.output.write_bytes(encode_result(result))


if __name__=='__main__': main()
