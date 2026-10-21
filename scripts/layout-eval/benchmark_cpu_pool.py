#!/usr/bin/env python3
"""Bounded development-only image inference through independent resident CPU workers.

No production router, remote calls, image IPC or reference data in workers. Aggregate
throughput is a host/process-pool result, never single-core or per-worker latency.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor,as_completed
import hashlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import queue
import resource
import time

_DETECTOR=None
_CONFIG=None


def sha(data):return hashlib.sha256(data).hexdigest()
def rss():return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024

def cgroup_snapshot():
    out={'logical_cpu_count':os.cpu_count(),'cpu_affinity_count':len(os.sched_getaffinity(0)) if hasattr(os,'sched_getaffinity') else None}
    for name in ('cpu.max','cpu.stat','cpuset.cpus.effective'):
        p=Path('/sys/fs/cgroup')/name
        out[name]=p.read_text().strip() if p.exists() else None
    quota=out.get('cpu.max')
    out['quota_cpu_equivalents']=None if not quota or quota.split()[0]=='max' else int(quota.split()[0])/int(quota.split()[1])
    out['quota_note']='cgroup v2 root snapshot; null means unavailable or no finite quota, not a verified dedicated-core allocation'
    return out


def image_from_item(item):
    from PIL import Image
    start=time.perf_counter();data=Path(item['image_path']).read_bytes();read=time.perf_counter()
    digest=sha(data);hashed=time.perf_counter()
    if digest!=item['image_sha256']:raise ValueError('Image SHA differs from frozen request')
    with Image.open(io.BytesIO(data)) as opened:image=opened.convert('RGB');image.load()
    end=time.perf_counter()
    if list(image.size)!=item['image_size']:raise ValueError('Image dimensions differ from frozen request')
    return image,{'source_read_ms':1000*(read-start),'source_hash_ms':1000*(hashed-read),'decode_ms':1000*(end-hashed)},len(data)


def initialize(config,warm_item,ready):
    global _DETECTOR,_CONFIG
    _CONFIG=config;start=time.perf_counter();cpu=time.process_time()
    from adapters import load_detector
    import cv2
    cv2.setNumThreads(config['threads'])
    _DETECTOR=load_detector('pp-small-onnx',onnx_path=config['onnx_path'],device='cpu',threads=config['threads'],precision='fp32',revision=config['revision'],local_files_only=True)
    loaded=time.perf_counter()
    for _ in range(config['warmup']):
        image,_,_=image_from_item(warm_item);_DETECTOR.predict([image],config['threshold'])
    ready.put({'pid':os.getpid(),'model_load_ms':1000*(loaded-start),'load_and_warmup_ms':1000*(time.perf_counter()-start),
        'startup_cpu_seconds':time.process_time()-cpu,'peak_rss_bytes':rss(),'model':_DETECTOR.metadata})


def ping():return os.getpid()


def execute(item):
    start=time.perf_counter();cpu=time.process_time();error=None;regions=[];times={};size=None
    try:
        image,times,size=image_from_item(item)
        predictions,detector_times=_DETECTOR.predict([image],_CONFIG['threshold']);regions=predictions[0];times.update(detector_times)
    except Exception as exception:error=f'{type(exception).__name__}: {exception}'
    finished=time.perf_counter()
    row={'page_id':item['page_id'],'repeat':item['repeat'],'regions':regions,'source_sha256':item['image_sha256'],
        'image_size':item['image_size'],'source_bytes':size,'worker_pid':os.getpid(),'error':error,'model':_DETECTOR.metadata,
        'timings':dict(times,worker_path_ms=1000*(finished-start)),'worker_cpu_seconds':time.process_time()-cpu,'worker_peak_rss_bytes':rss()}
    encoded_at=time.perf_counter();body=json.dumps(row,allow_nan=False).encode();serialized=time.perf_counter()
    return body,start,serialized,1000*(serialized-encoded_at),time.process_time()-cpu


def audit_predictions(rows,serial_path,box_iou=.999,confidence_atol=1e-4,ignore_repeat=False,box_atol=1e-5):
    from scoring import match_boxes
    baseline={}
    metadata_path=Path(serial_path).with_suffix('.metadata.json')
    baseline_metadata=json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    def graph(model):
        if 'graph_sha256' in model:return model['graph_sha256']
        return graph(model['detector']) if 'detector' in model else None
    for line in Path(serial_path).read_text().splitlines():
        row=json.loads(line);key=row['page_id'] if ignore_repeat else (row['page_id'],row['repeat'])
        if key in baseline:
            if ignore_repeat:
                if row['repeat']<baseline[key]['repeat']:baseline[key]=row
                continue
            raise ValueError('Duplicate serial audit key')
        baseline[key]=row
    checks=[]
    for row in rows:
        key=row['page_id'] if ignore_repeat else (row['page_id'],row['repeat']);other=baseline.get(key)
        reason=None;matches=[]
        if other is None:reason='missing serial pair'
        elif row.get('error') or other.get('error'):reason='inference failure'
        elif row['source_sha256']!=other['source_sha256'] or graph(row['model'])!=graph(other.get('model',baseline_metadata.get('model',{}))):reason='image or graph identity changed'
        else:
            pairs=match_boxes(other['regions'],row['regions'],box_iou)
            if len(pairs)!=len(row['regions']) or len(pairs)!=len(other['regions']):reason='detection count or approximate class/coordinates differ'
            else:
                for ti,pi,overlap in pairs:
                    left,right=other['regions'][ti],row['regions'][pi]
                    if left['raw_label']!=right['raw_label'] or abs(left['confidence']-right['confidence'])>confidence_atol:reason='raw label or score differs';break
                    if max(abs(a-b) for a,b in zip(left['bbox'],right['bbox']))>box_atol:reason='normalized coordinates exceed absolute tolerance';break
        checks.append({'page_id':row['page_id'],'repeat':row['repeat'],'pass':reason is None,'reason':reason})
    return {'scope':'Raw same-page/repeat prediction identity and approximate coordinates; no truth scoring.',
        'serial_path':str(serial_path),'serial_sha256':sha(Path(serial_path).read_bytes()),'minimum_iou':box_iou,'box_atol':box_atol,'confidence_atol':confidence_atol,
        'ignore_repeat':ignore_repeat,'serial_repeat_policy':'lowest available repeat per page' if ignore_repeat else 'exact page/repeat',
        'baseline_metadata_path':str(metadata_path) if metadata_path.exists() else None,
        'pass':all(v['pass'] for v in checks),'checks':checks}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',type=Path,required=True);p.add_argument('--split',choices=['dev'],default='dev')
    p.add_argument('--workers',type=int,choices=[1,2,4,8],default=1);p.add_argument('--threads',type=int,choices=[1,2,4],default=1)
    p.add_argument('--repeats',type=int,default=2);p.add_argument('--warmup',type=int,default=3);p.add_argument('--limit',type=int)
    p.add_argument('--onnx-path',type=Path,required=True);p.add_argument('--revision',required=True);p.add_argument('--threshold',type=float,default=.3)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--audit-serial',type=Path)
    p.add_argument('--audit-ignore-repeat',action='store_true');p.add_argument('--audit-box-atol',type=float,default=1e-5)
    p.add_argument('--max-seconds',type=float,default=180);p.add_argument('--maximum-jobs',type=int,default=2048);p.add_argument('--hourly-usd',type=float,default=0.)
    args=p.parse_args(argv)
    if args.output.exists() or args.output.with_suffix('.summary.json').exists():raise ValueError('Refuse evidence overwrite')
    if args.repeats<1 or args.warmup<0 or not 0<=args.threshold<=1 or not 0<args.max_seconds<=900 or not 1<=args.maximum_jobs<=10000 or not 0<=args.hourly_usd<5:raise ValueError('Invalid declared workload bounds')
    # Spawn does not inherit coordinator reference memory. Only these image identity fields enter workers.
    manifest=[json.loads(line) for line in args.manifest.read_text().splitlines() if line.strip()]
    if any(row.get('split')!='dev' for row in manifest):raise ValueError('A strict dev-only manifest is required')
    if args.limit:manifest=manifest[:args.limit]
    if not manifest:raise ValueError('Empty development input')
    if len(manifest)*args.repeats>args.maximum_jobs:raise ValueError('Declared maximum jobs exceeded')
    jobs=[]
    for repeat in range(args.repeats):
        for row in manifest:
            path=Path(row['image_path']);path=path if path.is_absolute() else args.manifest.parent/path
            expected=row.get('metadata',{}).get('image_sha256')
            if not expected:raise ValueError('Frozen image SHA required')
            jobs.append({'page_id':row['id'],'repeat':repeat,'image_path':str(path),'image_sha256':expected,'image_size':[row['width'],row['height']]})
    config={'threads':args.threads,'onnx_path':str(args.onnx_path.resolve()),'revision':args.revision,'threshold':args.threshold,'warmup':args.warmup}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    metadata={'schema':'layout-cpu-pool-v1','started_unix':time.time(),'manifest':str(args.manifest),'manifest_sha256':sha(args.manifest.read_bytes()),
        'workers':args.workers,'threads_per_worker':args.threads,'jobs':len(jobs),'warmup_per_worker':args.warmup,'config':config,
        'graph_sha256':sha(args.onnx_path.read_bytes()),'cgroup_before':cgroup_snapshot(),'deadline_seconds':args.max_seconds,
        'scope':'Aggregate resident CPU process pool, not single-core/single-worker speed; no production router.',
        'inference_boundary':'spawned workers receive image path, dimensions, expected SHA and opaque page/repeat identity only; no truth, schema, prose or labels',
        'memory_policy':'Per-worker high-water RSS only; maximum worker peak is not simultaneous aggregate RSS.',
        'image_ipc':False,'cost_scope':'allocated-host compute only; excludes model download, setup, storage and WAN'}
    args.output.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    for key in ('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS'):os.environ[key]=str(args.threads)
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    context=multiprocessing.get_context('spawn');ready=context.Queue();pool=None;workers=[];results=[];failure=None
    startup=time.perf_counter();deadline=startup+args.max_seconds;timed_start=None;parent_cpu=None;timed_end=None;parent_cpu_end=None
    try:
        pool=ProcessPoolExecutor(max_workers=args.workers,mp_context=context,initializer=initialize,initargs=(config,jobs[0],ready))
        probes=[pool.submit(ping) for _ in range(args.workers)]
        for _ in range(args.workers):workers.append(ready.get(timeout=max(.1,deadline-time.perf_counter())))
        for probe in probes:probe.result(timeout=max(.1,deadline-time.perf_counter()))
        startup_seconds=time.perf_counter()-startup;timed_start=time.perf_counter();parent_cpu=time.process_time()
        with args.output.open('x') as output:
            futures={}
            for item in jobs:
                submitted=time.perf_counter();futures[pool.submit(execute,item)]=(item,submitted)
            for future in as_completed(futures,timeout=max(.1,deadline-time.perf_counter())):
                item,submitted=futures[future];body,worker_start,serialized,serialize_ms,worker_cpu=future.result();received=time.perf_counter()
                row=json.loads(body);row['worker_cpu_seconds']=worker_cpu;decoded=time.perf_counter()
                row['timings'].update(queue_and_dispatch_ms=1000*(worker_start-submitted),worker_output_serialize_ms=serialize_ms,
                    return_transport_and_collection_ms=1000*(received-serialized),parent_output_decode_ms=1000*(decoded-received),
                    caller_completion_ms=1000*(decoded-submitted))
                row['serialized_output_bytes']=len(body);output.write(json.dumps(row,allow_nan=False)+'\n');output.flush();results.append(row)
            output.flush();os.fsync(output.fileno());timed_end=time.perf_counter();parent_cpu_end=time.process_time()
    except Exception as exception:failure=f'{type(exception).__name__}: {exception}'
    finally:
        if parent_cpu_end is None:parent_cpu_end=time.process_time()
        if pool is not None:
            if failure:
                # Public terminate_workers exists only in newer Python; terminate owned workers on deadline/error.
                for process in list((getattr(pool,'_processes',None) or {}).values()):process.terminate()
            pool.shutdown(wait=True,cancel_futures=True)
        ready.close()
    finished=time.perf_counter();end=timed_end or finished;elapsed=end-timed_start if timed_start is not None else None
    completed={(r['page_id'],r['repeat']) for r in results}
    missing=[dict(j,error=failure or 'missing completion') for j in jobs if (j['page_id'],j['repeat']) not in completed]
    successful=[r for r in results if not r['error']]
    report=dict(metadata,worker_initialization=workers,startup_seconds=(timed_start-startup) if timed_start else finished-startup,
        timed_wall_seconds=elapsed,completed=len(results),successful=len(successful),failed_completed=len(results)-len(successful),missing_attempts=missing,error=failure,
        delivered_pages_per_second=len(successful)/elapsed if elapsed else None,
        time_to_ingest_100_pages_seconds=100*elapsed/len(successful) if elapsed and successful else None,
        worker_job_cpu_seconds=sum(r['worker_cpu_seconds'] for r in results),parent_timed_cpu_seconds=parent_cpu_end-parent_cpu if parent_cpu is not None else None,
        total_timed_cpu_seconds=sum(r['worker_cpu_seconds'] for r in results)+(parent_cpu_end-parent_cpu if parent_cpu is not None else 0),
        cpu_time_scope='Worker task CPU including output serialization plus coordinator timed CPU; excludes process startup, warmup and worker IPC machinery outside task functions.',
        worker_peak_rss_by_pid={str(pid):max(r['worker_peak_rss_bytes'] for r in results if r['worker_pid']==pid) for pid in {r['worker_pid'] for r in results}},
        maximum_worker_peak_rss_bytes=max((r['worker_peak_rss_bytes'] for r in results),default=None),simultaneous_aggregate_rss_bytes=None,
        cgroup_after=cgroup_snapshot(),estimated_allocated_host_usd=(finished-startup)/3600*args.hourly_usd)
    if args.audit_serial:report['serial_prediction_audit']=audit_predictions(results,args.audit_serial,ignore_repeat=args.audit_ignore_repeat,box_atol=args.audit_box_atol)
    args.output.with_suffix('.summary.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ('workers','threads_per_worker','successful','timed_wall_seconds','delivered_pages_per_second','error')}))
    return 0 if not failure and not missing and len(successful)==len(jobs) and report.get('serial_prediction_audit',{}).get('pass',True) else 2


if __name__=='__main__':raise SystemExit(main())
