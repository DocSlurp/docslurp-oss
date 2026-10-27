#!/usr/bin/env python3
"""Check official native path/array and ONNX numerical parity without any labels."""
import argparse
import json
from pathlib import Path
from PIL import Image
from adapters import PaddleSmallDetector,OnnxSmallDetector,normalized_region,PADDLE_LABELS
from scoring import match_boxes


def compare(left,right):
    pairs=match_boxes(left,right,.99)
    return {'left_count':len(left),'right_count':len(right),'matched_iou99':len(pairs),
            'min_matched_iou':min((iou for _,_,iou in pairs),default=None),
            'max_matched_confidence_delta':max((abs(left[i]['confidence']-right[j]['confidence']) for i,j,_ in pairs),default=None),
            'all_matched':len(pairs)==len(left)==len(right)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image',type=Path,required=True)
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--onnx-path',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--revision')
    args=parser.parse_args()
    image=Image.open(args.image).convert('RGB')
    native=PaddleSmallDetector(model_path=str(args.model_dir),device='cpu',threads=2,revision=args.revision)
    array,nt=native.predict([image],.3)
    result=list(native.model.predict(input=str(args.image),batch_size=1,threshold=.3))[0].json
    result=result.get('res',result)
    path=[normalized_region(b['label'],b['score'],b['coordinate'],image.size,PADDLE_LABELS) for b in result['boxes']]
    ort=OnnxSmallDetector(onnx_path=str(args.onnx_path),device='cpu',threads=2,revision=args.revision)
    onnx,ot=ort.predict([image],.3)
    output={'native_array':array[0],'native_path':path,'onnx':onnx[0],
            'path_array_comparison':compare(path,array[0]),'native_onnx_comparison':compare(array[0],onnx[0]),
            'native_smoke_timings':nt,'onnx_smoke_timings':ot,'native_metadata':native.metadata,'onnx_metadata':ort.metadata,
            'scope':'one image runtime-parity readiness smoke; not accuracy or steady-state performance evidence'}
    args.output.write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps({key:value for key,value in output.items() if key.endswith('comparison')}))
    return 0 if output['path_array_comparison']['all_matched'] and output['native_onnx_comparison']['all_matched'] else 2


if __name__=='__main__': raise SystemExit(main())
