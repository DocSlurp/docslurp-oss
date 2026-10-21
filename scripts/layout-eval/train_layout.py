#!/usr/bin/env python3
"""Bounded train-only pretrained Heron experiment. Never accepts a mixed/holdout manifest."""
import argparse
import hashlib
import json
import math
import random
import resource
import time
from pathlib import Path
from custom_layout import ARCHITECTURE,LABELS,BASE_MODEL,BASE_REVISION,checkpoint_digest,convert_predictions


def digest(data): return hashlib.sha256(data).hexdigest()


def read_split(path,split):
    if split not in ('train','dev'): raise ValueError('Training cannot access holdout')
    data=Path(path).read_bytes()
    rows=[json.loads(line) for line in data.splitlines() if line.strip()]
    if not rows or any(row.get('split')!=split for row in rows):
        raise ValueError('Expected separate '+split+'-only manifest; mixed/holdout files forbidden')
    if len({row['id'] for row in rows})!=len(rows): raise ValueError('Duplicate training page')
    for row in rows:
        if not row.get('metadata',{}).get('source_id') or not row['metadata'].get('document_id'):
            raise ValueError('Source/document cluster provenance required')
        if not row['metadata'].get('image_sha256'): raise ValueError('Image hash required')
        targets(row)
    return rows,digest(data)


def targets(row):
    width,height=row['width'],row['height']
    if width<=0 or height<=0: raise ValueError('Invalid page dimensions')
    boxes=[];labels=[]
    for region in row['regions']:
        if region.get('visibility',1)<=0: continue
        if region['label'] not in LABELS: raise ValueError('Unknown training category')
        box=region['bbox']
        if len(box)!=4 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in box):
            raise ValueError('Invalid training box')
        if not (0<=box[0]<box[2]<=width and 0<=box[1]<box[3]<=height):
            raise ValueError('Training box outside image or degenerate')
        boxes.append(box);labels.append(LABELS.index(region['label']))
    return boxes,labels


def assert_disjoint(train,dev):
    for key in ('source_id','document_id','template_family'):
        left={row['metadata'].get(key) for row in train}-{None}
        right={row['metadata'].get(key) for row in dev}-{None}
        if left&right: raise ValueError('Train/dev cluster overlap: '+key)
    if {row['metadata']['image_sha256'] for row in train}&{row['metadata']['image_sha256'] for row in dev}:
        raise ValueError('Train/dev image overlap')


def load_image(root,row):
    from PIL import Image
    import io
    root=Path(root).resolve();path=(root/row['image_path']).resolve()
    if not path.is_relative_to(root): raise ValueError('Image path escapes dataset root')
    data=path.read_bytes()
    if digest(data)!=row['metadata']['image_sha256']: raise ValueError('Training image hash mismatch')
    image=Image.open(io.BytesIO(data)).convert('RGB')
    if image.size!=(row['width'],row['height']): raise ValueError('Training dimensions mismatch')
    return image


def move_inputs(value,device):
    if isinstance(value,dict):return {key:move_inputs(child,device) for key,child in value.items()}
    if isinstance(value,list):return [move_inputs(child,device) for child in value]
    return value.to(device) if hasattr(value,'to') else value


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',required=True,type=Path,help='Pre-separated train-only JSONL')
    parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path,help='New attempt directory; never overwrites')
    parser.add_argument('--dev-manifest',type=Path,help='Explicit dev-only checkpoint selection; no holdout option')
    parser.add_argument('--device',choices=['cpu','cuda'],default='cuda')
    parser.add_argument('--epochs',type=int,default=5);parser.add_argument('--max-steps',type=int,default=500)
    parser.add_argument('--max-seconds',type=int,default=1200)
    parser.add_argument('--batch-size',type=int,default=4);parser.add_argument('--threads',type=int,default=4)
    parser.add_argument('--seed',type=int,default=731);parser.add_argument('--learning-rate',type=float,default=.0001)
    args=parser.parse_args(argv)
    if not (1<=args.epochs<=30 and 1<=args.max_steps<=5000 and 1<=args.max_seconds<=1800
            and args.batch_size>=2 and args.threads>=1 and math.isfinite(args.learning_rate) and args.learning_rate>0):
        parser.error('Invalid bounded training configuration')
    args.output.mkdir(parents=True,exist_ok=False)
    started=time.perf_counter();receipt={'status':'started','config':{key:str(value) if isinstance(value,Path) else value for key,value in vars(args).items()},
        'architecture':ARCHITECTURE,'labels':list(LABELS),'initialization':'pretrained Heron with reset 14-class classifier',
        'base_model':BASE_MODEL,'base_revision':BASE_REVISION,
        'architecture_license':'Apache-2.0','native_weights_license':'Apache-2.0',
        'license_source':'https://huggingface.co/docling-project/docling-layout-heron/blob/main/README.md',
        'source_sha256':digest(Path(__file__).read_bytes()),'adapter_sha256':digest(Path(__file__).with_name('custom_layout.py').read_bytes()),
        'limitations':['Synthetic source/template-instance split; reused assets/primitives do not establish real-document generalization.',
                      'Short fine-tuning pilot is not an accuracy promise. No reading order or masks.'],
        'steps':0,'examples_seen':0,'epochs_completed':0,'checkpoint_selection':'dev macro F1 at IoU .50, threshold .30' if args.dev_manifest else 'last checkpoint; no dev access'}
    torch=None
    def save_receipt():
        receipt['elapsed_seconds']=time.perf_counter()-started
        receipt['peak_rss_bytes']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024
        if torch is not None and args.device=='cuda' and torch.cuda.is_available(): receipt['peak_vram_bytes']=torch.cuda.max_memory_allocated()
        (args.output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    save_receipt()
    try:
        train,receipt['train_manifest_sha256']=read_split(args.manifest,'train')
        dev=[]
        if args.dev_manifest:
            dev,receipt['dev_manifest_sha256']=read_split(args.dev_manifest,'dev');assert_disjoint(train,dev)
        receipt['train_pages']=len(train);receipt['dev_pages']=len(dev)
        import torch
        import transformers
        from transformers import AutoImageProcessor,AutoModelForObjectDetection
        if args.device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA unavailable')
        torch.set_num_threads(args.threads);torch.manual_seed(args.seed);random.seed(args.seed)
        if args.device=='cuda': torch.cuda.manual_seed_all(args.seed)
        torch.backends.cudnn.benchmark=False
        receipt.update(torch_version=str(torch.__version__),transformers_version=str(transformers.__version__),
                       optimizer={'kind':'AdamW','learning_rate':args.learning_rate,'weight_decay':.0001},
                       frozen_modules=['model.backbone','model.encoder'],
                       deterministic_algorithms=False,device=args.device)
        source=BASE_MODEL
        processor=AutoImageProcessor.from_pretrained(source,revision=BASE_REVISION,local_files_only=True,use_fast=False)
        model,loading=AutoModelForObjectDetection.from_pretrained(source,revision=BASE_REVISION,local_files_only=True,
            use_safetensors=True,num_labels=len(LABELS),id2label=dict(enumerate(LABELS)),
            label2id={label:index for index,label in enumerate(LABELS)},ignore_mismatched_sizes=True,output_loading_info=True)
        receipt['loading_info']=loading
        model.config.docslurp_layout_architecture=ARCHITECTURE
        frozen=[model.model.backbone,model.model.encoder]
        for module in frozen:
            for parameter in module.parameters():parameter.requires_grad_(False)
        model.to(args.device)
        receipt['trainable_parameters']=sum(p.numel() for p in model.parameters() if p.requires_grad)
        receipt['frozen_parameters']=sum(p.numel() for p in model.parameters() if not p.requires_grad)
        receipt['processor_size']=processor.size
        optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=args.learning_rate,weight_decay=.0001)
        best=-1.;stop=False
        for epoch in range(args.epochs):
            indices=list(range(len(train)));random.Random(args.seed+epoch).shuffle(indices)
            model.train()
            for module in frozen:module.eval()
            for offset in range(0,len(indices),args.batch_size):
                if receipt['steps']>=args.max_steps or time.perf_counter()-started>=args.max_seconds: stop=True;break
                batch=indices[offset:offset+args.batch_size]
                images=[];annotations=[]
                for index in batch:
                    row=train[index];image=load_image(args.root,row);boxes,labels=targets(row)
                    images.append(image)
                    annotations.append({'image_id':index,'annotations':[{'bbox':[box[0],box[1],box[2]-box[0],box[3]-box[1]],
                        'category_id':label,'area':(box[2]-box[0])*(box[3]-box[1]),'iscrowd':0} for box,label in zip(boxes,labels)]})
                inputs=move_inputs(dict(processor(images=images,annotations=annotations,return_tensors='pt')),args.device)
                optimizer.zero_grad(set_to_none=True);outputs=model(**inputs);loss=outputs.loss;losses=outputs.loss_dict
                if not torch.isfinite(loss): raise RuntimeError('Nonfinite training loss')
                loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),10.);optimizer.step()
                if args.device=='cuda':torch.cuda.synchronize()
                receipt['steps']+=1
                receipt['examples_seen']+=len(batch)
                receipt['epoch_equivalents']=receipt['examples_seen']/len(train)
                event={'step':receipt['steps'],'epoch':epoch+1,'elapsed_seconds':time.perf_counter()-started,
                       'loss':float(loss.detach()),'components':{key:float(value.detach()) for key,value in losses.items()}}
                with (args.output/'losses.jsonl').open('a') as stream:stream.write(json.dumps(event)+'\n')
                save_receipt()
            if not stop:receipt['epochs_completed']=epoch+1
            model.eval();quality=None
            if dev and not stop and time.perf_counter()-started<args.max_seconds:
                from scoring import score_pages
                pages=[]
                for row in dev:
                    if time.perf_counter()-started>=args.max_seconds: stop=True;break
                    image=load_image(args.root,row)
                    inputs=processor(images=[image],return_tensors='pt').to(args.device)
                    with torch.inference_mode():outputs=model(**inputs)
                    pred=processor.post_process_object_detection(outputs,threshold=.3,target_sizes=[(image.height,image.width)])
                    boxes,labels=targets(row)
                    truth=[{'label':LABELS[label],'bbox':[v/s for v,s in zip(box,(row['width'],row['height'],row['width'],row['height']))]} for box,label in zip(boxes,labels)]
                    pages.append({'truth':truth,'regions':convert_predictions(pred,[image],.3)[0]})
                if len(pages)==len(dev):
                    quality=score_pages(pages,LABELS)['iou50']['macro_f1_truth_present']
                    with (args.output/'dev-selection.jsonl').open('a') as stream:stream.write(json.dumps({'epoch':epoch+1,'macro_f1_iou50':quality,'pages':len(pages)})+'\n')
            provenance={key:value for key,value in receipt.items() if key not in ('config',)}
            model.config.docslurp_training=provenance
            model.save_pretrained(args.output/'last',safe_serialization=True);processor.save_pretrained(args.output/'last')
            if quality is not None and quality>best:
                best=quality;model.save_pretrained(args.output/'best-dev',safe_serialization=True);processor.save_pretrained(args.output/'best-dev')
                receipt['best_dev_macro_f1']=best
            if stop:break
        if receipt['steps']==0: raise RuntimeError('Training budget ended before any optimizer step')
        receipt['status']='completed';receipt['stop_reason']='budget' if stop else 'epochs'
        receipt['last_checkpoint_sha256']=checkpoint_digest(args.output/'last')
    except BaseException as error:
        receipt['status']='failed';receipt['error']={'type':type(error).__name__,'message':str(error)}
        raise
    finally:save_receipt()


if __name__=='__main__': main()
