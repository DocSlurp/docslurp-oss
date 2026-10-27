"""Fresh randomized paired document timing, with no OCR-cache reuse or label access.

Run only after policy freeze. This is local extraction latency, not production ingestion.
"""
import argparse,json,os,random,resource,socket,tempfile,time
from datetime import datetime,timezone
from pathlib import Path
import fitz
from contract import file_hash,identity_hash,immutable_json,validate_policy_receipt,validate_manifest,evaluation_identity
from measure import invoke,features,ocr,OCR_BINARY_HASH,OCR_LANGUAGE_HASH
from optimize import choose

def extract(path,policy,cache):
    doc=fitz.open(path);mode=policy['mode'];texts=[]
    native=[]
    if mode in ['native','ladder']:
        output,_=invoke(['pdftotext','-layout',str(path),'-'])
        native=output.decode().split('\f')
        if len(native)==len(doc)+1 and not native[-1].strip():native.pop()
        if len(native)!=len(doc):raise RuntimeError('timing-page-alignment')
    if mode=='ladder':invoke(['pdfimages','-list',str(path)])
    residual={}
    if mode=='ladder' and policy.get('byteThreshold',0)>0 and policy['byteBasis']!='contentDecodedBytes':
        size=1 if policy['byteBasis']=='singleResidualBytes' else 4
        from measure import stream_bytes
        invoke(['qpdf',f'--split-pages={size}',str(path),str(cache/'part-%d.pdf')])
        index=0
        for part in sorted(cache.glob('part-*.pdf')):
            chunk=fitz.open(part)
            refs={r for page in chunk for image in page.get_images(full=True) for r in image[:2] if r}
            value=(part.stat().st_size-stream_bytes(chunk,refs,True))/len(chunk)
            for _ in chunk:residual[index]=value;index+=1
            chunk.close()
    for index,page in enumerate(doc):
        selected=mode;fast=None
        if mode=='ladder':
            feat=features(doc,page,native[index])
            if residual:feat[policy['byteBasis']]=residual[index]
            probe={'features':feat,'candidates':{'ocr-fast':{'confidence':101}}}
            selected,_=choose(probe,policy)
        if selected=='native':texts.append(native[index]);continue
        if selected=='ocr-fast' or mode=='ladder':
            fast=ocr(page.get_pixmap(dpi=150,alpha=False).tobytes('png'),cache,150,6,use_cache=False)
            selected='ocr-strong' if mode=='ladder' and fast['confidence']<policy['confidenceThreshold'] else 'ocr-fast'
        if selected=='ocr-strong':
            result=ocr(page.get_pixmap(dpi=300,alpha=False).tobytes('png'),cache,300,3,use_cache=False)
        else:result=fast
        texts.append(result['text'])
    doc.close()
    return identity_hash(texts)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--dataset',type=Path,required=True);p.add_argument('--run',type=Path,required=True)
    p.add_argument('--scorers',type=Path,required=True)
    p.add_argument('--policy',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    os.environ.setdefault('TMPDIR','/home/dan/tmp/agents');os.environ['MIXED_EVAL_WORKERS']='1'
    identity=json.loads((a.run/'evaluation-identity.json').read_text());receipt=json.loads(a.policy.read_text())
    live=evaluation_identity(a.dataset,a.scorers,Path(__file__).with_name('measure.py'),OCR_BINARY_HASH,OCR_LANGUAGE_HASH,fitz.VersionBind)
    if live!=identity:raise RuntimeError('timing-live-identity-mismatch')
    validate_policy_receipt(receipt,live,file_hash(Path(__file__).with_name('optimize.py')),file_hash(a.run/'tune-complete.json'))
    manifest=json.loads((a.dataset/'manifest.json').read_text())
    if identity_hash(manifest)!=identity['datasetCanonicalHash']:raise RuntimeError('timing-manifest-mismatch')
    cases=validate_manifest(manifest)
    ids=[f'mixed-source-{f:04d}-hard-{h:03d}' for f,h in zip([0,7,14,3,10,17],[0,20,40,60,80,100])]
    selected=[next(c for c in cases if c['id']==identifier and c['split']=='train') for identifier in ids]
    rng=random.Random(48131);schedule=[]
    for repeat in range(3):
        order=selected.copy();rng.shuffle(order)
        for case in order:
            arms=['selected','strong'];rng.shuffle(arms)
            for arm in arms:schedule.append({'case':case['id'],'repeat':repeat,'arm':arm})
    a.out.mkdir(parents=True,exist_ok=True)
    immutable_json(a.out/'schedule.json',{'policyHash':file_hash(a.policy),'timingCodeHash':file_hash(Path(__file__)),'schedule':schedule})
    for index,item in enumerate(schedule):
        output=a.out/f'{index:03d}.json'
        if output.exists():raise RuntimeError('fresh-timing-refuses-resume-use-new-output')
        case=next(c for c in selected if c['id']==item['case']);path=a.dataset/case['pdf']
        if file_hash(path)!=case['sha256']:raise RuntimeError('timing-source-changed')
        policy=receipt['policy'] if item['arm']=='selected' else {'mode':'ocr-strong'}
        os.environ['MIXED_EVAL_ATTEMPT']=f'timing-{index}'
        cpu=lambda:sum(resource.getrusage(w).ru_utime+resource.getrusage(w).ru_stime for w in [resource.RUSAGE_SELF,resource.RUSAGE_CHILDREN])
        with tempfile.TemporaryDirectory(prefix='mixed-timing-',dir=os.environ['TMPDIR']) as tmp:
            started=datetime.now(timezone.utc).isoformat();before=cpu();clock=time.perf_counter()
            output_hash=extract(path,policy,Path(tmp))
            result={**item,'startedAt':started,'host':socket.gethostname(),'workers':1,'elapsedSeconds':time.perf_counter()-clock,
                    'cpuSeconds':cpu()-before,'outputHash':output_hash,'pages':len(case['pages']),'policyHash':file_hash(a.policy)}
        immutable_json(output,result);print(json.dumps(result),flush=True)
    immutable_json(a.out/'complete.json',{'scheduleHash':file_hash(a.out/'schedule.json'),'samples':len(schedule)})
