#!/usr/bin/env python3
"""Paired image-layout experiments. Only images enter detectors; labels enter scoring later."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import random
import resource
import statistics
import sys
import time
from adapters import load_detector
from scoring import score_pages


def read_manifest(path):
    path=Path(path)
    if path.suffix=='.jsonl': rows=[json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    else:
        data=json.loads(path.read_text()); rows=data['pages'] if isinstance(data,dict) else data
    return rows


def load_reference(row,root):
    if 'regions' in row: return row
    data=json.loads((root/row['reference_path']).read_text())
    return dict(data,width=data.get('width',data.get('image',{}).get('width')),
                height=data.get('height',data.get('image',{}).get('height')))


def normalized_truth(reference):
    width,height=reference['width'],reference['height']
    return [dict(region,bbox=[v/s for v,s in zip(region['bbox'],(width,height,width,height))])
            for region in reference['regions'] if region.get('visibility',1)>0]


def transform_bytes(data,variant):
    """Resample and encode transport payload, then decode exactly what detector sees.

    Stored pixel orientation is preserved: no implicit EXIF rotation. Transform
    cost is reported separately; measured e2e includes it (producer + consumer).
    """
    from PIL import Image
    start=time.perf_counter()
    with Image.open(io.BytesIO(data)) as opened:
        image=opened.convert('RGB')
    source_size=image.size
    decoded=time.perf_counter()
    max_edge=variant.get('max_edge')
    if max_edge:
        scale=min(1.,max_edge/max(image.size))
        image=image.resize((max(1,round(image.width*scale)),max(1,round(image.height*scale))),Image.Resampling.LANCZOS)
    if variant.get('grayscale'): image=image.convert('L')
    if variant.get('palette_colors'):
        colors=variant['palette_colors']
        if not isinstance(colors,int) or not 2<=colors<=256: raise ValueError('Palette color count must be 2..256')
        image=image.convert('RGB').quantize(colors=colors,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE)
    if 'binary_threshold' in variant:
        threshold=variant['binary_threshold']
        if not 0<=threshold<=255: raise ValueError('Binary threshold must be 0..255')
        image=image.convert('L').point(lambda pixel:255 if pixel>=threshold else 0,mode='1')
    codec=variant.get('codec','original').upper()
    unchanged=codec=='ORIGINAL' and not max_edge and not variant.get('grayscale') and not variant.get('palette_colors') and 'binary_threshold' not in variant
    if unchanged:
        payload=data
    else:
        if codec=='ORIGINAL': codec='PNG'
        options={'quality':variant.get('quality',80)} if codec in ('JPEG','WEBP','AVIF') else {}
        if codec=='JPEG':
            options['subsampling']=variant.get('subsampling',2)
            if image.mode not in ('L','RGB'): image=image.convert('RGB')
        if codec=='WEBP': options['lossless']=bool(variant.get('lossless',False))
        if codec=='AVIF': options['speed']=variant.get('speed',8)
        buffer=io.BytesIO(); image.save(buffer,format=codec,**options); payload=buffer.getvalue()
    encoded=time.perf_counter()
    if not unchanged:
        with Image.open(io.BytesIO(payload)) as opened:
            image=opened.convert('RGB')
    end=time.perf_counter()
    producer_ms=0. if unchanged else 1000*(encoded-start)
    consumer_decode_ms=1000*(decoded-start) if unchanged else 1000*(end-encoded)
    return image,{'source_decode_ms':1000*(decoded-start),'transform_encode_ms':1000*(encoded-decoded),
                  'payload_decode_ms':0. if unchanged else 1000*(end-encoded),
                  'producer_path_ms':producer_ms,'consumer_decode_ms':consumer_decode_ms,'source_bytes':len(data),'source_sha256':hashlib.sha256(data).hexdigest(),'payload_bytes':len(payload),
                  'source_size':source_size,'input_size':image.size,'payload_sha256':hashlib.sha256(payload).hexdigest()}


def stats(values):
    values=sorted(values)
    if not values: return None
    def percentile(p):
        index=(len(values)-1)*p; lower=int(index); upper=min(lower+1,len(values)-1)
        return values[lower]+(values[upper]-values[lower])*(index-lower)
    return dict(n=len(values),mean=statistics.mean(values),p50=percentile(.5),p90=percentile(.9),p95=percentile(.95),max=max(values))


def summarize(rows,supported,hourly_usd):
    successful=[row for row in rows if not row.get('error')]
    timing_keys=sorted(set(key for row in successful for key in row['timings']))
    output={'attempts':len(rows),'failures':len(rows)-len(successful),
            'unique_page_images':len(set(r.get('page_id') for r in rows if r.get('page_id'))),
            'unique_authored_sources':len(set(r.get('metadata',{}).get('source_id',r.get('page_id')) for r in rows)),
            'successful_latency_ms':{key:stats([r['timings'][key] for r in successful if key in r['timings']]) for key in timing_keys},
            'all_attempt_end_to_end_ms':stats([r['timings']['end_to_end_ms'] for r in rows]),
            'payload_bytes':stats([r['payload_bytes'] for r in successful]),
            'scores':score_pages(rows,supported),'quality_scope':'synthetic silver; not real-world validation'}
    runtime_ms=sum(r['timings']['end_to_end_ms'] for r in rows)
    output['throughput_pages_per_second']=len(successful)*1000/runtime_ms if runtime_ms else None
    output['compute_usd_per_1000_successful_pages']=hourly_usd*runtime_ms/3_600_000*1000/len(successful) if successful else None
    return output


def parse_args(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path,help='Fresh JSONL path; existing output is rejected')
    parser.add_argument('--model',choices=['heron','ppv3','pp-small','pp-small-onnx'],default='heron')
    parser.add_argument('--device',default='cpu')
    parser.add_argument('--precision',choices=['fp32','fp16'],default='fp32')
    parser.add_argument('--threads',type=int,default=4)
    parser.add_argument('--processor',choices=['slow','fast'],default='slow')
    parser.add_argument('--visual-classifier',choices=['none','siglip2'],default='none')
    parser.add_argument('--classifier-model-path')
    parser.add_argument('--classifier-revision')
    parser.add_argument('--classifier-minimum-margin',type=float,default=.02)
    parser.add_argument('--classifier-batch-size',type=int,default=16)
    parser.add_argument('--batch-size',type=int,default=1)
    parser.add_argument('--model-size',type=int,help='Transformers model input square size; independent from payload resolution')
    parser.add_argument('--onnx-path')
    parser.add_argument('--paddle-mkldnn',action='store_true')
    parser.add_argument('--model-path')
    parser.add_argument('--revision')
    parser.add_argument('--orientation-onnx-path')
    parser.add_argument('--orientation-revision',default='unknown')
    parser.add_argument('--orientation-minimum-score',type=float,default=.75)
    parser.add_argument('--local-files-only',action='store_true')
    parser.add_argument('--split',default='dev')
    parser.add_argument('--limit',type=int)
    parser.add_argument('--threshold',type=float,default=.3)
    parser.add_argument('--warmup',type=int,default=3)
    parser.add_argument('--repeats',type=int,default=2)
    parser.add_argument('--seed',type=int,default=417)
    parser.add_argument('--hourly-usd',type=float,default=0.)
    parser.add_argument('--variants',type=Path,help='JSON list of {name,max_edge,codec,quality,grayscale,subsampling}')
    parser.add_argument('--allow-holdout',action='store_true',help='Only use after selecting configurations on dev')
    args=parser.parse_args(argv)
    if min(args.batch_size,args.threads,args.repeats)<1 or args.warmup<0: parser.error('Invalid batch/thread/repeat/warmup count')
    if args.hourly_usd<0 or args.hourly_usd>=5: parser.error('Hourly price must be nonnegative and below $5')
    if args.split=='holdout' and not args.allow_holdout: parser.error('Holdout requires --allow-holdout after development tuning')
    return args


def main(argv=None):
    args=parse_args(argv)
    if args.output.exists(): raise ValueError(f'Refuse to overwrite evidence {args.output}')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    manifest_digest=hashlib.sha256(args.manifest.read_bytes()).hexdigest()
    rows=[r for r in read_manifest(args.manifest) if r.get('split')==args.split]
    random.Random(args.seed).shuffle(rows)
    if args.limit: rows=rows[:args.limit]
    if not rows: raise ValueError(f'No pages in split {args.split}')
    variants=json.loads(args.variants.read_text()) if args.variants else [{'name':'original','codec':'original'}]
    if len({v['name'] for v in variants})!=len(variants): raise ValueError('Variant names must be unique')
    model_start=time.perf_counter()
    detector=load_detector(args.model,device=args.device,precision=args.precision,threads=args.threads,
                           model_size=args.model_size,paddle_mkldnn=args.paddle_mkldnn,onnx_path=args.onnx_path,model_path=args.model_path,
                           revision=args.revision,processor=args.processor,local_files_only=args.local_files_only)
    if args.visual_classifier=='siglip2':
        from visual_classifier import VisualCropClassifier,VisualClassifierDetector
        classifier=VisualCropClassifier(device=args.device,precision=args.precision,threads=args.threads,
            batch_size=args.classifier_batch_size,minimum_margin=args.classifier_minimum_margin,
            revision=args.classifier_revision,model_path=args.classifier_model_path,local_files_only=args.local_files_only)
        detector=VisualClassifierDetector(detector,classifier)
    if args.orientation_onnx_path:
        from orientation import OnnxOrientation,OrientedDetector
        detector=OrientedDetector(detector,OnnxOrientation(args.orientation_onnx_path,threads=args.threads,
            minimum_score=args.orientation_minimum_score,revision=args.orientation_revision))
    model_load_ms=1000*(time.perf_counter()-model_start)
    root=args.manifest.parent
    # Warmup uses source image bytes only, never references.
    sample=(root/rows[0]['image_path']).read_bytes()
    image,_=transform_bytes(sample,variants[0])
    for _ in range(args.warmup): detector.predict([image]*args.batch_size,args.threshold)
    run_id=args.output.stem
    all_results=[]; campaign_start=time.perf_counter()
    metadata={'schema_version':'layout-benchmark-v1','run_id':run_id,'model':detector.metadata,
        'manifest_sha256':manifest_digest,'device':args.device,'host':platform.node(),'platform':platform.platform(),
        'python':sys.version,'cpu_count':os.cpu_count(),'batch_size':args.batch_size,'warmup_batches':args.warmup,
        'model_load_ms':model_load_ms,'threshold':args.threshold,'split':args.split,'seed':args.seed,
        'hourly_usd':args.hourly_usd,'cost_exclusions':['storage','network','idle setup','provider minimum billing'],
        'timer_semantics':'batch model stages amortized per image; original bytes decoded once as consumer; derivatives measure producer decode+resize+encode and consumer decode; e2e includes local read and all measured stages; no network',
        'variants':variants,'selected_page_ids':[r['id'] for r in rows],
        'started_unix':time.time()}
    args.output.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    with args.output.open('x') as stream:
        for repeat in range(args.repeats):
            # Balanced randomized variant order reduces warm-cache/thermal drift bias.
            ordered=list(variants); random.Random(args.seed+repeat).shuffle(ordered)
            for variant in ordered:
                for offset in range(0,len(rows),args.batch_size):
                    batch=rows[offset:offset+args.batch_size]; images=[]; details=[]
                    batch_start=time.perf_counter()
                    try:
                        for row in batch:
                            read_start=time.perf_counter(); data=(root/row['image_path']).read_bytes(); read_ms=1000*(time.perf_counter()-read_start)
                            expected=row.get('metadata',{}).get('image_sha256')
                            if expected and hashlib.sha256(data).hexdigest()!=expected: raise ValueError('Source image differs from manifest hash')
                            image,detail=transform_bytes(data,variant); detail['read_ms']=read_ms
                            if tuple(detail['source_size'])!=(row['width'],row['height']): raise ValueError('Source dimensions differ from manifest reference')
                            images.append(image); details.append(detail)
                        predictions,timings=detector.predict(images,args.threshold)
                        if len(predictions)!=len(batch): raise ValueError('Detector result count differs from input batch')
                        elapsed=1000*(time.perf_counter()-batch_start)
                        error=None
                    except Exception as exception:
                        predictions=[[] for _ in batch]; timings={}; error=f'{type(exception).__name__}: {exception}'
                        elapsed=1000*(time.perf_counter()-batch_start)
                    # Load reference only AFTER inference finished, outside all performance timers.
                    for index,(row,regions) in enumerate(zip(batch,predictions)):
                        detail=details[index] if index<len(details) else {}
                        image_metadata=getattr(detector,'last_image_metadata',[])
                        if not error and index<len(image_metadata): detail.update(image_metadata[index])
                        amortized={key:value/len(batch) for key,value in timings.items()}
                        timings_out={key:detail[key] for key in ('source_decode_ms','transform_encode_ms','payload_decode_ms','producer_path_ms','consumer_decode_ms','read_ms') if key in detail}
                        timings_out.update(amortized,end_to_end_ms=elapsed/len(batch))
                        if not error:
                            timings_out['consumer_path_ms']=detail['consumer_decode_ms']+sum(amortized.values())
                        truth=normalized_truth(load_reference(row,root))
                        result=dict(page_id=row['id'],variant=variant['name'],repeat=repeat,regions=regions,truth=truth,
                            metadata=row.get('metadata',{}),source_family=row.get('source_family',row.get('metadata',{}).get('source_family')),
                            timings=timings_out,batch_count=len(batch),error=error,**detail)
                        stream.write(json.dumps(result)+'\n'); stream.flush(); all_results.append(result)
                    print(json.dumps({'variant':variant['name'],'repeat':repeat,'completed':min(offset+len(batch),len(rows)),
                                      'pages':len(rows),'batch_ms':elapsed,'error':error}),flush=True)
    summaries={}
    for variant in variants:
        selected=[r for r in all_results if r['variant']==variant['name']]
        summaries[variant['name']]=summarize(selected,detector.supported_labels,args.hourly_usd)
        summaries[variant['name']]['per_family']={family:score_pages([r for r in selected if r.get('source_family')==family],detector.supported_labels)
                                                for family in sorted(set(r['source_family'] for r in selected if r.get('source_family')))}
        summaries[variant['name']]['per_capture']={capture:score_pages([r for r in selected if r.get('metadata',{}).get('capture_variant')==capture],detector.supported_labels)
            for capture in sorted(set(r.get('metadata',{}).get('capture_variant') for r in selected if r.get('metadata',{}).get('capture_variant')))}
        summaries[variant['name']]['per_difficulty']={difficulty:score_pages([r for r in selected if r.get('metadata',{}).get('difficulty')==difficulty],detector.supported_labels)
            for difficulty in sorted(set(r.get('metadata',{}).get('difficulty') for r in selected if r.get('metadata',{}).get('difficulty')))}
    report=dict(metadata,elapsed_wall_seconds=time.perf_counter()-campaign_start,
        rss_peak_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,
        model_memory=detector.memory(),summaries=summaries,final_model_metadata=detector.metadata)
    report['measured_wall_compute_usd']=report['elapsed_wall_seconds']/3600*args.hourly_usd
    args.output.with_suffix('.summary.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'summary':str(args.output.with_suffix('.summary.json')),'attempts':len(all_results)}))
    return 0 if all(not row.get('error') for row in all_results) else 2


if __name__=='__main__': sys.exit(main())
