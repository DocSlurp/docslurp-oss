"""Optional image-only figure crop classification; no corpus/reference access.

Official model: https://huggingface.co/google/siglip2-base-patch16-224
Apache-2.0 model card verified 2026-10-20. Cosine scores/margins are uncalibrated
similarity signals, not probabilities. Prompts v1 were fixed before any campaign
classification results. Native detector classes such as chart remain untouched.
"""
import copy
import hashlib
import json
import math
import time

MODEL_ID = 'google/siglip2-base-patch16-224'
PROMPTS_VERSION = 'visual-crop-v1'
PROMPTS = (
 ('photo', 'A photograph of a real-world scene, people, objects, or landscape.'),
 ('chart', 'A data chart or graph showing quantitative values with axes, bars, lines, or pie slices.'),
 ('logo', 'A company logo, brand mark, emblem, or distinctive graphic symbol.'),
 ('illustration', 'An illustration, drawing, painting, cartoon, or decorative artwork.'),
 ('mind_map', 'A mind map or concept map with labeled nodes connected by branching lines.'),
 ('figure', 'A document crop containing text, a diagram, or other unclassified visual content.'),
)
PROMPTS_SHA256 = hashlib.sha256(json.dumps(PROMPTS,separators=(',',':')).encode()).hexdigest()


def classify_scores(scores, minimum_margin=.02):
    """Choose a class without hiding ambiguity; figure is the abstention label."""
    if len(scores)!=len(PROMPTS) or not all(math.isfinite(float(x)) for x in scores):
        raise ValueError('Malformed or nonfinite classifier scores')
    ranked=sorted(range(len(scores)),key=lambda index:float(scores[index]),reverse=True)
    first,second=ranked[:2]; margin=float(scores[first])-float(scores[second])
    candidate=PROMPTS[first][0]
    accepted=candidate!='figure' and margin>=minimum_margin
    return {'label':candidate if accepted else 'figure','candidateLabel':candidate,
            'score':float(scores[first]),'margin':margin,'accepted':accepted,
            'scoreKind':'cosine-similarity-not-probability'}


def crop_box(image,bbox):
    if len(bbox)!=4 or not all(math.isfinite(float(x)) and 0<=x<=1 for x in bbox):
        raise ValueError('Invalid normalized figure crop')
    x0,y0,x1,y1=bbox
    if x0>=x1 or y0>=y1: raise ValueError('Degenerate figure crop')
    return (math.floor(x0*image.width),math.floor(y0*image.height),
            math.ceil(x1*image.width),math.ceil(y1*image.height))


class VisualCropClassifier:
    def __init__(self,device='cpu',precision='fp32',threads=4,batch_size=16,
                 minimum_margin=.02,revision=None,model_path=None,local_files_only=True):
        import torch
        from transformers import AutoModel,AutoProcessor
        if device not in ('cpu','cuda'): raise ValueError('Classifier device must be cpu or cuda')
        if device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('Classifier CUDA unavailable')
        if precision not in ('fp32','fp16') or (device=='cpu' and precision=='fp16'):
            raise ValueError('Classifier requires CPU fp32 or CUDA fp32/fp16')
        if batch_size<1 or not math.isfinite(minimum_margin) or minimum_margin<0:
            raise ValueError('Invalid classifier batching or margin')
        torch.set_num_threads(threads)
        self.torch,self.device,self.batch_size,self.minimum_margin=torch,device,batch_size,minimum_margin
        self.dtype=torch.float16 if precision=='fp16' else torch.float32
        source=model_path or MODEL_ID
        self.processor=AutoProcessor.from_pretrained(source,revision=revision,local_files_only=local_files_only)
        self.model=AutoModel.from_pretrained(source,revision=revision,local_files_only=local_files_only).eval().to(device=device,dtype=self.dtype)
        tokens=self.processor(text=[text for _,text in PROMPTS],padding='max_length',truncation=True,return_tensors='pt').to(device)
        with torch.inference_mode():
            features=self.model.get_text_features(**tokens)
            if not isinstance(features,torch.Tensor): features=features.pooler_output
            self.text_features=torch.nn.functional.normalize(features.float(),dim=-1)
        self.metadata={'id':MODEL_ID,'revision':getattr(self.model.config,'_commit_hash',None) or revision or 'unknown',
            'device':device,'precision':precision,'prompt_version':PROMPTS_VERSION,'prompt_sha256':PROMPTS_SHA256,
            'prompts':list(PROMPTS),'minimum_margin':minimum_margin,'batch_size':batch_size,
            'score_kind':'cosine-similarity-not-probability','scope':'only detector figure boxes; no missed-region recovery'}

    def sync(self):
        if self.device=='cuda': self.torch.cuda.synchronize()

    def classify(self,images):
        self.sync(); start=time.perf_counter(); decisions=[]
        for offset in range(0,len(images),self.batch_size):
            batch=images[offset:offset+self.batch_size]
            inputs=self.processor(images=batch,return_tensors='pt').to(self.device)
            inputs={key:value.to(dtype=self.dtype) if value.is_floating_point() else value for key,value in inputs.items()}
            with self.torch.inference_mode():
                features=self.model.get_image_features(**inputs)
                if not isinstance(features,self.torch.Tensor): features=features.pooler_output
                features=self.torch.nn.functional.normalize(features.float(),dim=-1)
                scores=(features @ self.text_features.T).cpu().tolist()
            decisions.extend(classify_scores(row,self.minimum_margin) for row in scores)
        self.sync()
        return decisions,1000*(time.perf_counter()-start)


class VisualClassifierDetector:
    """Composes a detector without exposing ground truth to either model."""
    def __init__(self,base,classifier):
        self.base,self.classifier=base,classifier
        self.supported_labels=sorted(set(base.supported_labels)|{label for label,_ in PROMPTS})
        self.metadata={'detector':base.metadata,'visual_classifier':classifier.metadata,'id':base.metadata['id'],
                       'revision':base.metadata.get('revision','unknown')}
        if base.metadata.get('graph_sha256'): self.metadata['graph_sha256']=base.metadata['graph_sha256']

    def predict(self,images,threshold=.3):
        predictions,timings=self.base.predict(images,threshold)
        if len(predictions)!=len(images): raise ValueError('Detector batch length mismatch')
        # Never rewrite base output in place: enables paired ablations on same boxes.
        predictions=copy.deepcopy(predictions)
        start=time.perf_counter(); crops=[]; locations=[]
        for page_index,(image,regions) in enumerate(zip(images,predictions)):
            for region_index,region in enumerate(regions):
                if region['label']!='figure': continue
                crops.append(image.crop(crop_box(image,region['bbox'])).convert('RGB'))
                locations.append((page_index,region_index))
        crop_ms=1000*(time.perf_counter()-start)
        decisions,classifier_ms=self.classifier.classify(crops) if crops else ([],0.)
        if len(decisions)!=len(locations): raise ValueError('Classifier batch length mismatch')
        for (page_index,region_index),decision in zip(locations,decisions):
            region=predictions[page_index][region_index]
            region['detector_label']=region['label']
            region['label']=decision['label']
            region['classification']=dict(decision,model=MODEL_ID,promptVersion=PROMPTS_VERSION)
            # Original detector raw_label/confidence and bbox are untouched.
        return predictions,dict(timings,visual_crop_ms=crop_ms,visual_classification_ms=classifier_ms)

    def memory(self): return self.base.memory()
