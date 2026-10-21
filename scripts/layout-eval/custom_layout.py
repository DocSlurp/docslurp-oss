"""Image-only cached custom Heron detector; no manifests or reference access."""
import hashlib
import json
import math
import time
from pathlib import Path

LABELS = ('paragraph','title','list','table','chart','photo','logo','formula',
          'caption','header','footer','form','mind_map','illustration')
ARCHITECTURE = 'docslurp/heron-custom'
BASE_MODEL = 'docling-project/docling-layout-heron'
BASE_REVISION = '8f39ad3c0b4c58e9c2d2c84a38465abf757272d8'


def checkpoint_digest(path):
    root=Path(path);files=sorted([*root.glob('*.safetensors'),root/'config.json',root/'preprocessor_config.json'])
    if not any(file.suffix=='.safetensors' for file in files): raise ValueError('Missing safetensors checkpoint')
    value=hashlib.sha256()
    for file in files:value.update(file.name.encode());value.update(b'\0');value.update(hashlib.sha256(file.read_bytes()).digest())
    return value.hexdigest()


def validate_config(config):
    mapping={int(key):value for key,value in config.get('id2label',{}).items()}
    if config.get('docslurp_layout_architecture')!=ARCHITECTURE or mapping!=dict(enumerate(LABELS)):
        raise ValueError('Unsupported custom checkpoint class contract')


def convert_predictions(predictions,images,threshold):
    if len(predictions)!=len(images): raise ValueError('Prediction count mismatch')
    output=[]
    for prediction,image in zip(predictions,images):
        width,height=image.size;regions=[]
        for box,score,index in zip(prediction['boxes'].tolist(),prediction['scores'].tolist(),prediction['labels'].tolist()):
            if not math.isfinite(score) or not 0<=score<=1: raise ValueError('Invalid detector confidence')
            if score<threshold: continue
            if not 0<=index<len(LABELS): raise ValueError('Unknown custom detector class')
            if len(box)!=4 or not all(math.isfinite(v) for v in box): raise ValueError('Invalid detector box')
            bbox=[min(1.,max(0.,float(v)/s)) for v,s in zip(box,(width,height,width,height))]
            if bbox[0]>=bbox[2] or bbox[1]>=bbox[3]: continue
            label=LABELS[index]
            regions.append(dict(label=label,raw_label=label,confidence=float(score),bbox=bbox))
        output.append(regions)
    return output


class CustomLayoutDetector:
    def __init__(self,model_path=None,device='cpu',threads=4,precision='fp32',model_size=None,processor='slow',**_):
        import torch
        from transformers import AutoImageProcessor,AutoModelForObjectDetection
        if not model_path: raise ValueError('Custom detector requires explicit checkpoint directory')
        if device not in ('cpu','cuda') or (device=='cuda' and not torch.cuda.is_available()):
            raise ValueError('Requested custom detector device unavailable')
        if precision not in ('fp32','fp16') or (device=='cpu' and precision!='fp32'):
            raise ValueError('Custom detector supports CPU fp32 or CUDA fp32/fp16')
        if processor not in ('slow','fast'):raise ValueError('Unsupported custom processor')
        if model_size is not None and (not isinstance(model_size,int) or model_size<32 or model_size>2048 or model_size%32):raise ValueError('Custom model size must be a multiple of32 in32..2048')
        self.model_size=model_size
        torch.set_num_threads(threads);self.torch,self.device=torch,device
        config=json.loads((Path(model_path)/'config.json').read_text());validate_config(config)
        self.dtype=torch.float16 if precision=='fp16' else torch.float32
        self.processor=AutoImageProcessor.from_pretrained(model_path,local_files_only=True,use_fast=processor=='fast')
        self.model=AutoModelForObjectDetection.from_pretrained(model_path,local_files_only=True,use_safetensors=True).to(device=device,dtype=self.dtype).eval()
        self.supported_labels=list(LABELS);digest=checkpoint_digest(model_path)
        self.metadata={'id':ARCHITECTURE,'revision':digest,'graph_sha256':digest,'runtime':'transformers',
                       'precision':precision,'model_size':model_size or self.processor.size,'threads':threads,
                       'processor_requested':processor,'processor_class':type(self.processor).__name__,
                       'processor_backend':getattr(self.processor,'backend',None),
                       'training':config.get('docslurp_training',{}),'reading_order_supported':False}

    def sync(self):
        if self.device=='cuda': self.torch.cuda.synchronize()

    def predict(self,images,threshold=.3):
        self.sync();start=time.perf_counter()
        kwargs={'size':{'height':self.model_size,'width':self.model_size}} if self.model_size else {}
        inputs=self.processor(images=images,return_tensors='pt',**kwargs).to(self.device)
        self.metadata['last_input_tensor_shape']=list(inputs['pixel_values'].shape)
        inputs={key:value.to(dtype=self.dtype) if value.is_floating_point() else value for key,value in inputs.items()}
        self.sync();prepared=time.perf_counter()
        with self.torch.inference_mode(): predictions=self.model(**inputs)
        self.sync();inferred=time.perf_counter()
        decoded=self.processor.post_process_object_detection(predictions,threshold=threshold,target_sizes=[(image.height,image.width) for image in images])
        regions=convert_predictions(decoded,images,threshold)
        return regions,{'preprocess_ms':1000*(prepared-start),'inference_ms':1000*(inferred-prepared),
                        'postprocess_ms':1000*(time.perf_counter()-inferred)}

    def memory(self):
        return {'cuda_peak_allocated_bytes':self.torch.cuda.max_memory_allocated()} if self.device=='cuda' else {}
