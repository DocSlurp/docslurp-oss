"""Image-only adapters. No reference annotations or corpus metadata accepted."""
import time
import math

HERON_LABELS={'caption':'caption','footnote':'footnote','formula':'formula','list_item':'list',
 'page_footer':'footer','page_header':'header','picture':'figure','section_header':'title',
 'table':'table','text':'paragraph','title':'title','document_index':'table','code':'code',
 'form':'form','key_value_region':'form'}
PADDLE_LABELS={'paragraph_title':'title','doc_title':'title','image':'figure','text':'paragraph',
 'abstract':'paragraph','content':'paragraph','reference':'paragraph','aside_text':'paragraph',
 'figure_title':'caption','table_title':'caption','chart_title':'caption','formula':'formula',
 'table':'table','header':'header','footer':'footer','footnote':'footnote','chart':'chart',
 'algorithm':'code','seal':'seal','header_image':'figure','footer_image':'figure',
 'formula_number':'formula_number','number':'number','reference_content':'paragraph','vision_footnote':'footnote'}
PADDLE_SMALL_CLASSES=['paragraph_title','image','text','number','abstract','content','figure_title',
 'formula','table','table_title','reference','doc_title','footnote','header','algorithm','footer',
 'seal','chart_title','chart','formula_number','header_image','footer_image','aside_text']


def canonical(raw,mapping):
    return mapping.get(raw.lower().replace('-','_').replace(' ','_'),'unknown')


def normalized_region(raw,score,box,size,mapping,**extra):
    width,height=size
    if len(box)!=4 or not all(math.isfinite(float(v)) for v in box) or not math.isfinite(float(score)):
        raise ValueError('Non-finite or malformed detector output')
    normalized=[min(1.,max(0.,float(v)/s)) for v,s in zip(box,(width,height,width,height))]
    if normalized[0]>=normalized[2] or normalized[1]>=normalized[3]:
        raise ValueError('Degenerate detector output after clipping')
    return dict(label=canonical(raw,mapping),raw_label=raw,confidence=float(score),bbox=normalized,**extra)


def normalized_polygon(points,size):
    if hasattr(points,'tolist'): points=points.tolist()
    if not points or len(points)<3: return None
    output=[]
    for point in points:
        if len(point)!=2 or not all(math.isfinite(float(v)) for v in point): raise ValueError('Malformed polygon output')
        output.append([min(1.,max(0.,float(point[0])/size[0])),min(1.,max(0.,float(point[1])/size[1]))])
    return output


class TransformersDetector:
    def __init__(self,model='heron',device='cpu',precision='fp32',threads=4,model_size=None,
                 revision=None,model_path=None,local_files_only=False,processor='slow',**_):
        import torch
        from transformers import AutoImageProcessor,AutoModelForObjectDetection
        torch.set_num_threads(threads)
        if precision=='fp16' and device=='cpu': raise ValueError('CPU fp16 excluded; use fp32 or measured quantized backend')
        self.torch,self.device,self.model_family=torch,device,model
        self.model_id={'heron':'docling-project/docling-layout-heron','ppv3':'PaddlePaddle/PP-DocLayoutV3_safetensors'}[model]
        self.mapping=HERON_LABELS if model=='heron' else PADDLE_LABELS
        source=model_path or self.model_id
        self.processor=AutoImageProcessor.from_pretrained(source,revision=revision,local_files_only=local_files_only,use_fast=processor=='fast')
        self.model=AutoModelForObjectDetection.from_pretrained(source,revision=revision,local_files_only=local_files_only).eval().to(device)
        self.dtype=torch.float16 if precision=='fp16' else torch.float32
        self.model.to(dtype=self.dtype); self.model_size=model_size
        self.supported_labels=sorted(set(canonical(str(v),self.mapping) for v in self.model.config.id2label.values()))
        self.revision=getattr(self.model.config,'_commit_hash',None) or revision or 'unknown'
        self.metadata={'id':self.model_id,'revision':self.revision,'runtime':'transformers','precision':precision,
            'threads':threads,'model_size':model_size,'processor':processor,'processor_class':type(self.processor).__name__,'source_labels':self.model.config.id2label,
            'native_reading_order':model=='ppv3','native_polygons':model=='ppv3','parameter_count':sum(p.numel() for p in self.model.parameters())}

    def sync(self):
        if self.device.startswith('cuda'): self.torch.cuda.synchronize(self.device)

    def predict(self,images,threshold=.3):
        self.sync(); start=time.perf_counter()
        kwargs={'size':{'height':self.model_size,'width':self.model_size}} if self.model_size else {}
        inputs=self.processor(images=images,return_tensors='pt',**kwargs).to(self.device)
        inputs={k:v.to(dtype=self.dtype) if v.is_floating_point() else v for k,v in inputs.items()}
        self.metadata['last_input_tensor_shape']=list(inputs['pixel_values'].shape)
        self.sync(); pre=time.perf_counter()
        with self.torch.inference_mode(): outputs=self.model(**inputs)
        self.sync(); infer=time.perf_counter()
        results=self.processor.post_process_object_detection(outputs,threshold=threshold,target_sizes=[(im.height,im.width) for im in images])
        predictions=[]
        for image,result in zip(images,results):
            regions=[]
            for index,(score,label,box) in enumerate(zip(result['scores'].tolist(),result['labels'].tolist(),result['boxes'].tolist())):
                region=normalized_region(str(self.model.config.id2label[int(label)]),score,box,image.size,self.mapping)
                if self.model_family=='ppv3':
                    # Official PPv3 postprocessor returns detections sorted by its predicted logical order.
                    region['reading_order']=int(result['order_seq'][index]) if 'order_seq' in result else index
                    if 'polygon_points' not in result: raise ValueError('PPv3 postprocessor omitted native polygons')
                    polygon=normalized_polygon(result['polygon_points'][index],image.size)
                    if polygon: region['polygon']=polygon
                regions.append(region)
            predictions.append(regions)
        self.sync(); end=time.perf_counter()
        return predictions,{'preprocess_ms':1000*(pre-start),'inference_ms':1000*(infer-pre),'postprocess_ms':1000*(end-infer)}

    def memory(self):
        return {'cuda_peak_allocated_bytes':self.torch.cuda.max_memory_allocated(self.device)} if self.device.startswith('cuda') else {}


class PaddleSmallDetector:
    def __init__(self,device='cpu',threads=4,precision='fp32',model_size=None,model_path=None,revision=None,paddle_mkldnn=False,**_):
        if precision!='fp32' or model_size: raise ValueError('Native PP-small supports fp32/default 480 only')
        from paddleocr import LayoutDetection
        kwargs={'model_dir':model_path} if model_path else {}
        self.device=device
        self.model=LayoutDetection(model_name='PP-DocLayout-S',device=device.replace('cuda','gpu'),cpu_threads=threads,enable_mkldnn=paddle_mkldnn,**kwargs)
        self.supported_labels=sorted(set(PADDLE_LABELS.values()))
        self.metadata={'id':'PaddlePaddle/PP-DocLayout-S','revision':revision or 'unknown','runtime':'paddleocr',
                       'precision':'fp32','threads':threads,'model_size':480,'mkldnn':paddle_mkldnn,'ndarray_color':'BGR-converted-from-RGB'}

    def predict(self,images,threshold=.3):
        import numpy as np
        import paddle
        if self.device.startswith('cuda'): paddle.device.cuda.synchronize()
        start=time.perf_counter()
        results=list(self.model.predict(input=[np.ascontiguousarray(np.asarray(im)[:,:,::-1]) for im in images],batch_size=len(images),threshold=threshold))
        regions=[]
        for image,result in zip(images,results):
            data=result.json
            if callable(data): data=data()
            data=data.get('res',data)
            regions.append([normalized_region(b['label'],b['score'],b['coordinate'],image.size,PADDLE_LABELS) for b in data['boxes']])
        if self.device.startswith('cuda'): paddle.device.cuda.synchronize()
        return regions,{'native_pipeline_ms':1000*(time.perf_counter()-start)}

    def memory(self): return {}


class OnnxSmallDetector:
    """Local Paddle2ONNX PP-DocLayout-S graph: normalized RGB NCHW + scale_factor.

    Export an Apache-2.0 upstream checkpoint or supply an audited graph. Its digest
    is recorded. No remote Python or unreviewed model code is executed.
    """
    def __init__(self,onnx_path=None,device='cpu',threads=4,precision='fp32',revision=None,**_):
        import hashlib
        import onnxruntime as ort
        if not onnx_path: raise ValueError('--onnx-path required')
        if precision!='fp32': raise ValueError('ONNX precision encoded in graph; keep --precision fp32')
        options=ort.SessionOptions(); options.intra_op_num_threads=threads
        options.graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers=['CUDAExecutionProvider','CPUExecutionProvider'] if device.startswith('cuda') else ['CPUExecutionProvider']
        if providers[0] not in ort.get_available_providers(): raise RuntimeError(f'Unavailable provider {providers[0]}')
        if device.startswith('cuda'):
            # Reuse installed PyTorch CUDA12/cuDNN libraries when present, per ORT deployment guidance.
            try:
                import torch
            except ImportError:
                pass
        self.session=ort.InferenceSession(onnx_path,sess_options=options,providers=providers)
        if device.startswith('cuda') and self.session.get_providers()[0]!='CUDAExecutionProvider':
            raise RuntimeError('Requested CUDA ONNX provider failed to initialize; refusing full CPU fallback')
        self.supported_labels=sorted(set(PADDLE_LABELS.values()))
        self.metadata={'id':'PaddlePaddle/PP-DocLayout-S','revision':revision or 'unknown','runtime':'onnxruntime',
            'graph_sha256':hashlib.sha256(open(onnx_path,'rb').read()).hexdigest(),
            'input_specs':[{'name':v.name,'shape':v.shape,'type':v.type} for v in self.session.get_inputs()],
            'providers':self.session.get_providers(),'provider_options':self.session.get_provider_options(),'precision':'graph-defined','threads':threads,
            'cuda_cpu_node_fallback_possible':device.startswith('cuda'),'batch_execution':'serial-fixed-1','resize':'opencv-INTER_CUBIC','color':'RGB'}

    def predict(self,images,threshold=.3):
        import numpy as np
        import cv2
        output=[]; timing={'preprocess_ms':0.,'inference_ms':0.,'postprocess_ms':0.}
        for image in images:
            start=time.perf_counter()
            data=cv2.resize(np.asarray(image),(480,480),interpolation=cv2.INTER_CUBIC).astype(np.float32)/255.
            data=(data-np.array([.485,.456,.406],dtype=np.float32))/np.array([.229,.224,.225],dtype=np.float32)
            feed={'image':data.transpose(2,0,1)[None],'scale_factor':np.array([[480/image.height,480/image.width]],dtype=np.float32)}
            pre=time.perf_counter(); results=self.session.run(None,feed); infer=time.perf_counter()
            boxes,count=results[:2]; boxes=boxes.reshape(-1,6)[:int(np.asarray(count).flatten()[0])]
            output.append([normalized_region(PADDLE_SMALL_CLASSES[int(row[0])],row[1],row[2:6],image.size,PADDLE_LABELS)
                           for row in boxes if row[1]>=threshold])
            end=time.perf_counter()
            for key,value in zip(timing,[pre-start,infer-pre,end-infer]): timing[key]+=1000*value
        return output,timing

    def memory(self): return {}


def load_detector(model,**kwargs):
    if model in ('heron','ppv3'): return TransformersDetector(model=model,**kwargs)
    if model=='pp-small': return PaddleSmallDetector(**kwargs)
    if model=='pp-small-onnx': return OnnxSmallDetector(**kwargs)
    raise ValueError(f'Unknown detector {model}')
