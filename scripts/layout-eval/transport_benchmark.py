#!/usr/bin/env python3
"""Measure raw-byte resident HTTP versus fresh CLI processes; never uses or sends truth labels.

Managed HTTP and CLI phases run separately so two model instances do not share GPU
memory. Cold means fresh Python/model instance, not an uncached filesystem. Source
identity, fingerprints, raw responses, load time and caller E2E are retained.
"""
import argparse
from contextlib import contextmanager
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path
import random
import re
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from infer import add_detector_arguments,MAX_INPUT_BYTES,MAX_OUTPUT_BYTES
from benchmark import stats
from fingerprints import describe_region
from scoring import match_boxes


def forwarded_arguments(args,parser):
    output=[]
    for action in parser._actions:
        if action.dest=='help': continue
        value=getattr(args,action.dest)
        if value is None: continue
        option=next(name for name in action.option_strings if name.startswith('--'))
        if action.nargs==0:
            if value: output.append(option)
        else: output.extend((option,str(value)))
    return output


def loopback_url(value):
    parsed=urlsplit(value)
    if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost') or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Resident benchmark endpoint must be plain HTTP on IPv4 loopback without credentials')
    if parsed.path not in ('','/'): raise ValueError('Endpoint must be a server origin, not a path')
    return parsed.hostname,parsed.port or 80


def request_json(origin,path,data=None,timeout=120):
    host,port=loopback_url(origin)
    connection=http.client.HTTPConnection(host,port,timeout=timeout)
    start=time.perf_counter()
    try:
        headers={'Content-Type':'application/octet-stream','Content-Length':str(len(data))} if data is not None else {}
        connection.request('POST' if data is not None else 'GET',path,body=data,headers=headers)
        response=connection.getresponse(); body=response.read(MAX_OUTPUT_BYTES+1)
        received=time.perf_counter()
        if len(body)>MAX_OUTPUT_BYTES: raise ValueError('Resident response exceeds output bound')
        if response.status!=200: raise RuntimeError(f'HTTP {response.status}: {body[:300]!r}')
        result=json.loads(body)
        end=time.perf_counter()
        return result,{'transport_ms':1000*(received-start),'response_parse_ms':1000*(end-received),
                       'request_response_ms':1000*(end-start),'response_bytes':len(body),
                       'response_sha256':hashlib.sha256(body).hexdigest()}
    finally: connection.close()


def image_identity(data):
    from PIL import Image
    if not data or len(data)>MAX_INPUT_BYTES: raise ValueError('Image bytes outside supported bound')
    with Image.open(io.BytesIO(data)) as image:
        if getattr(image,'n_frames',1)!=1: raise ValueError('Only one stored raster frame is supported')
        width,height=image.size
    return {'width':width,'height':height,'sha256':hashlib.sha256(data).hexdigest()}


def validate_result(result,data,verify_fingerprints=True):
    expected=image_identity(data)
    if result.get('schemaVersion')!=1 or result.get('coordinateSpace')!='normalized-source' or result.get('image')!=expected:
        raise ValueError('Source SHA/dimensions or coordinate contract mismatch')
    if not isinstance(result.get('model'),dict) or not all(isinstance(result['model'].get(key),str) for key in ('id','revision')):
        raise ValueError('Missing model identity')
    if not isinstance(result.get('regions'),list): raise ValueError('Missing region list')
    image=None
    if verify_fingerprints:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as opened: image=opened.convert('RGB')
    for region in result['regions']:
        box=region.get('bbox',[]); confidence=region.get('confidence')
        if len(box)!=4 or not all(isinstance(v,(int,float)) and math.isfinite(v) and 0<=v<=1 for v in box) or box[0]>=box[2] or box[1]>=box[3]:
            raise ValueError('Invalid normalized region geometry')
        if not isinstance(confidence,(int,float)) or not math.isfinite(confidence) or not 0<=confidence<=1: raise ValueError('Invalid confidence')
        fingerprint=region.get('fingerprint',{})
        if fingerprint.get('algorithm')!='dhash-64' or not re.fullmatch('[0-9a-f]{16}',fingerprint.get('value','')):
            raise ValueError('Missing perceptual fingerprint')
        if not re.fullmatch('[0-9a-f]{64}',region.get('exactCropSha256','')): raise ValueError('Missing exact crop digest')
        if image is not None:
            actual=describe_region(image,region)
            if any(region.get(key)!=actual[key] for key in ('fingerprint','exactCropSha256','imageCoverage')):
                raise ValueError('Returned fingerprint does not match source crop pixels')
    return expected


def compare_results(left,right):
    if left is None or right is None: return {'parity':False,'reason':'missing successful response'}
    identity=all(left.get(key)==right.get(key) for key in ('schemaVersion','model','device','image','coordinateSpace','supportedLabels'))
    pairs=match_boxes(left['regions'],right['regions'],.999)
    equal_counts=len(pairs)==len(left['regions'])==len(right['regions'])
    confidence=max((abs(left['regions'][i]['confidence']-right['regions'][j]['confidence']) for i,j,_ in pairs),default=0.)
    raw_labels=all(left['regions'][i]['rawLabel']==right['regions'][j]['rawLabel'] for i,j,_ in pairs)
    return {'parity':identity and equal_counts and raw_labels and confidence<=1e-4,'same_identity':identity,
            'matched_iou999':len(pairs),'left_regions':len(left['regions']),'right_regions':len(right['regions']),
            'max_confidence_delta':confidence,'exact_regions_equal':left['regions']==right['regions'],
            'exact_crop_digest_matches':sum(left['regions'][i]['exactCropSha256']==right['regions'][j]['exactCropSha256'] for i,j,_ in pairs),
            'note':'Each response fingerprint is independently verified; subpixel box differences may change exact crop hashes.'}


@contextmanager
def resident(args,detector_args,output,deadline):
    if args.server_url:
        origin=args.server_url; health,_=request_json(origin,'/health',timeout=min(args.startup_timeout,max(1,deadline-time.monotonic())))
        yield origin,{'ownership':'attached','health':health,'co_resident_models_possible_during_cli':True}
        return
    with socket.socket() as socket_handle:
        socket_handle.bind(('127.0.0.1',0)); port=socket_handle.getsockname()[1]
    origin=f'http://127.0.0.1:{port}'
    command=[args.python,str(args.server_script),'--port',str(port),*detector_args]
    start=time.perf_counter()
    with (output/'resident-server.log').open('x') as log:
        process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,env=dict(os.environ,HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1'))
        try:
            until=min(deadline,time.monotonic()+args.startup_timeout)
            while True:
                if process.poll() is not None: raise RuntimeError(f'Resident exited {process.returncode}; see resident-server.log')
                try:
                    health,_=request_json(origin,'/health',timeout=.5)
                    if health.get('ready'): break
                except (OSError,RuntimeError,http.client.HTTPException): pass
                if time.monotonic()>=until: raise TimeoutError('Resident startup timeout')
                time.sleep(.05)
            yield origin,{'ownership':'managed','command':command,'health':health,
                          'startup_to_health_ms':1000*(time.perf_counter()-start),'co_resident_models_possible_during_cli':False}
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)


def select_images(args):
    if args.image: return [{'id':path.stem,'path':path.resolve()} for path in args.image]
    rows=[json.loads(line) for line in args.manifest.read_text().splitlines() if line.strip()]
    rows=[row for row in rows if row.get('split')==args.split]
    random.Random(args.seed).shuffle(rows)
    return [{'id':row['id'],'path':(args.manifest.parent/row['image_path']).resolve(),
             'declared_sha256':row.get('metadata',{}).get('image_sha256')} for row in rows[:args.limit]]


def main():
    detector_parser=argparse.ArgumentParser(add_help=False); add_detector_arguments(detector_parser)
    parser=argparse.ArgumentParser(description=__doc__,parents=[detector_parser])
    inputs=parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--image',type=Path,nargs='+'); inputs.add_argument('--manifest',type=Path)
    parser.add_argument('--split',choices=['train','dev'],default='dev')
    parser.add_argument('--limit',type=int,default=8); parser.add_argument('--repeats',type=int,default=3)
    parser.add_argument('--warmup',type=int,default=3); parser.add_argument('--seed',type=int,default=417)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--python',default=sys.executable)
    parser.add_argument('--server-script',type=Path,default=Path(__file__).with_name('server.py'))
    parser.add_argument('--cli-script',type=Path,default=Path(__file__).with_name('infer.py'))
    parser.add_argument('--server-url'); parser.add_argument('--phase-order',choices=['http-first','cli-first'],default='http-first')
    parser.add_argument('--startup-timeout',type=float,default=60); parser.add_argument('--request-timeout',type=float,default=120)
    parser.add_argument('--max-seconds',type=float,default=300); parser.add_argument('--hourly-usd',type=float,default=0.)
    args=parser.parse_args()
    if min(args.repeats,args.limit)<1 or args.warmup<0 or not 0<args.max_seconds<=18000 or not 0<=args.hourly_usd<5:
        parser.error('Invalid repeat/limit/runtime/price bound')
    if args.server_url: loopback_url(args.server_url)
    output=args.output_dir.resolve()
    if output.exists(): raise ValueError('Refuse to overwrite transport evidence')
    output.mkdir(parents=True); (output/'cli-logs').mkdir()
    detector_args=forwarded_arguments(args,detector_parser); images=select_images(args)
    if not images: raise ValueError('No selected image inputs')
    deadline=time.monotonic()+args.max_seconds; started=time.time(); records=[]; server_metadata=None
    metadata={'schema_version':'layout-transport-benchmark-v1','created_unix':started,'detector_arguments':detector_args,
        'python':args.python,'phase_order':args.phase_order,'input_ids':[row['id'] for row in images],
        'repeats':args.repeats,'warmup_requests':args.warmup,'hourly_usd':args.hourly_usd,'max_seconds':args.max_seconds,
        'scope':'raw raster bytes only; no reference labels used or sent',
        'cold_definition':'fresh Python/model process; OS file cache is uncontrolled',
        'http_definition':'resident model, new loopback TCP connection per request; includes response JSON parse',
        'verification':'source SHA/dimensions and every returned crop fingerprint verified outside measured caller E2E'}
    (output/'plan.json').write_text(json.dumps(metadata,indent=2)+'\n')
    scratch_root=os.environ.get('TMPDIR') or '/home/dan/tmp/agents'
    with tempfile.TemporaryDirectory(prefix='layout-transport-',dir=scratch_root) as scratch, (output/'responses.jsonl').open('x') as stream:
        def execute(mode,origin=None):
            for repeat in range(args.repeats):
                ordered=list(enumerate(images)); random.Random(args.seed+repeat).shuffle(ordered)
                for index,row in ordered:
                    start=time.perf_counter(); data=row['path'].read_bytes(); read_ms=1000*(time.perf_counter()-start)
                    if row.get('declared_sha256') and hashlib.sha256(data).hexdigest()!=row['declared_sha256']: raise ValueError('Manifest image digest changed')
                    remaining=min(args.request_timeout,deadline-time.monotonic())
                    if remaining<=0: raise TimeoutError('Declared transport campaign bound reached')
                    result=None; detail={}; error=None; operation=time.perf_counter()
                    try:
                        if mode=='http': result,detail=request_json(origin,'/layout',data,remaining)
                        else:
                            target=Path(scratch)/f'{index}-{repeat}.json'
                            command=[args.python,str(args.cli_script),'--image',str(row['path']),'--output',str(target),*detector_args]
                            with (output/'cli-logs'/f'{index}-{repeat}.log').open('x') as log:
                                completed=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=remaining,
                                    env=dict(os.environ,HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1'))
                            if completed.returncode: raise RuntimeError(f'CLI exit {completed.returncode}')
                            body=target.read_bytes()
                            if len(body)>MAX_OUTPUT_BYTES: raise ValueError('CLI output too large')
                            result=json.loads(body); detail={'command':command,'response_bytes':len(body),'response_sha256':hashlib.sha256(body).hexdigest()}
                        measured_ms=1000*(time.perf_counter()-operation)
                        verify=time.perf_counter(); identity=validate_result(result,data); verification_ms=1000*(time.perf_counter()-verify)
                    except Exception as exception:
                        measured_ms=1000*(time.perf_counter()-operation); error=f'{type(exception).__name__}: {exception}'
                        identity=image_identity(data); verification_ms=None
                    record={'mode':mode,'image_id':row['id'],'image_index':index,'repeat':repeat,'source':identity,
                        'source_bytes':len(data),'source_read_ms':read_ms,'caller_end_to_end_ms':read_ms+measured_ms,
                        'operation_ms':measured_ms,'verification_ms':verification_ms,'error':error,'response':result,**detail}
                    stream.write(json.dumps(record,allow_nan=False)+'\n'); stream.flush(); records.append(record)
                    print(json.dumps({'mode':mode,'image_id':row['id'],'repeat':repeat,'caller_end_to_end_ms':record['caller_end_to_end_ms'],'error':error}),flush=True)
        for mode in (['http','cli'] if args.phase_order=='http-first' else ['cli','http']):
            if mode=='cli': execute(mode)
            else:
                with resident(args,detector_args,output,deadline) as (origin,server_metadata):
                    warmup=images[0]['path'].read_bytes()
                    for _ in range(args.warmup): request_json(origin,'/layout',warmup,min(args.request_timeout,max(1,deadline-time.monotonic())))
                    execute(mode,origin)
    by={(r['image_index'],r['repeat'],r['mode']):r for r in records}
    pairs=[]
    for repeat in range(args.repeats):
        for index,row in enumerate(images):
            left=by.get((index,repeat,'http')); right=by.get((index,repeat,'cli'))
            parity=compare_results(left['response'] if left and not left['error'] else None,right['response'] if right and not right['error'] else None)
            pairs.append(dict(image_id=row['id'],repeat=repeat,**parity))
    summaries={}
    for mode in ('http','cli'):
        selected=[r for r in records if r['mode']==mode]; successful=[r for r in selected if not r['error']]
        summaries[mode]={'attempts':len(selected),'failures':len(selected)-len(successful),
            'caller_end_to_end_ms':stats([r['caller_end_to_end_ms'] for r in successful]),
            'model_load_ms':stats([r['response']['diagnostics']['modelLoadMs'] for r in successful if 'modelLoadMs' in r['response'].get('diagnostics',{})]),
            'model_decode_fingerprints_ms':stats([r['response']['diagnostics']['elapsedMs'] for r in successful]),
            'delivered_pages_per_second':len(successful)*1000/sum(r['caller_end_to_end_ms'] for r in selected) if selected else None}
    report=dict(metadata,server=server_metadata,summaries=summaries,pairs=pairs,elapsed_seconds=time.time()-started)
    report['estimated_allocated_host_usd']=report['elapsed_seconds']/3600*args.hourly_usd
    (output/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
    return 0 if all(not row['error'] for row in records) and all(pair['parity'] for pair in pairs) else 2


if __name__=='__main__': raise SystemExit(main())
