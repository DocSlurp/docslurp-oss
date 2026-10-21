"""Optional CPU ONNX orientation prepass, with boxes mapped back to stored pixels.

Primary source: PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx (Apache-2.0).
Official config: RGB, OpenCV LINEAR short-edge256, center224, ImageNet normalization.
Angles denote counterclockwise correction, matching Paddle's doc preprocessor.
This corrects right-angle rotation only, not skew, perspective, or page curvature.
"""
import copy
import hashlib
import math
import time


def inverse_point(x,y,correction):
    if correction==0: return x,y
    if correction==90: return 1-y,x
    if correction==180: return 1-x,1-y
    if correction==270: return y,1-x
    raise ValueError('Only right-angle rotations supported')


def inverse_bbox(box,correction):
    x0,y0,x1,y1=box
    points=[inverse_point(x,y,correction) for x,y in ((x0,y0),(x1,y0),(x1,y1),(x0,y1))]
    return [min(x for x,y in points),min(y for x,y in points),max(x for x,y in points),max(y for x,y in points)]


def choose_orientation(scores,minimum_score=.75):
    if len(scores)!=4 or not all(math.isfinite(float(x)) and 0<=float(x)<=1 for x in scores):
        raise ValueError('Orientation graph must emit four finite probabilities')
    if abs(sum(float(x) for x in scores)-1)>.01: raise ValueError('Orientation graph output is not normalized probabilities')
    index=max(range(4),key=lambda i:scores[i]); score=float(scores[index])
    return {'predicted_angle':index*90,'correction_angle':index*90 if score>=minimum_score else 0,
            'model_score':score,'minimum_score':minimum_score,'accepted':score>=minimum_score}


class OnnxOrientation:
    def __init__(self,model_path,threads=2,minimum_score=.75,revision='unknown'):
        import onnxruntime as ort
        if not 0<=minimum_score<=1: raise ValueError('Orientation minimum score out of range')
        options=ort.SessionOptions(); options.intra_op_num_threads=threads
        self.session=ort.InferenceSession(str(model_path),sess_options=options,providers=['CPUExecutionProvider'])
        self.minimum_score=minimum_score
        self.metadata={'id':'PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx','revision':revision,
            'graph_sha256':hashlib.sha256(open(model_path,'rb').read()).hexdigest(),
            'runtime':'onnxruntime','device':'cpu','threads':threads,'minimum_score':minimum_score,
            'geometry':'counterclockwise-right-angle-correction-then-inverse-source-boxes'}

    def classify(self,images):
        import cv2
        import numpy as np
        start=time.perf_counter(); output=[]
        for image in images:
            width,height=image.size; scale=256/min(width,height)
            resized=cv2.resize(np.asarray(image),(round(width*scale),round(height*scale)),interpolation=cv2.INTER_LINEAR)
            h,w=resized.shape[:2]; x=(w-224)//2; y=(h-224)//2
            data=resized[y:y+224,x:x+224].astype(np.float32)*(1./255.)
            data=(data-np.array([.485,.456,.406],dtype=np.float32))/np.array([.229,.224,.225],dtype=np.float32)
            feed={self.session.get_inputs()[0].name:data.transpose(2,0,1)[None]}
            scores=self.session.run(None,feed)[0].reshape(-1).tolist()
            output.append(choose_orientation(scores,self.minimum_score))
        return output,1000*(time.perf_counter()-start)


class OrientedDetector:
    def __init__(self,base,orientation):
        self.base,self.orientation=base,orientation
        self.supported_labels=base.supported_labels
        self.metadata={'id':base.metadata['id'],'revision':base.metadata.get('revision','unknown'),
                       'detector':base.metadata,'orientation':orientation.metadata}
        self.last_image_metadata=[]

    def predict(self,images,threshold=.3):
        from PIL import Image
        decisions,classify_ms=self.orientation.classify(images)
        start=time.perf_counter(); corrected=[]
        methods={90:Image.Transpose.ROTATE_90,180:Image.Transpose.ROTATE_180,270:Image.Transpose.ROTATE_270}
        for image,decision in zip(images,decisions):
            angle=decision['correction_angle']; corrected.append(image.transpose(methods[angle]) if angle else image)
        rotate_ms=1000*(time.perf_counter()-start)
        predictions,timings=self.base.predict(corrected,threshold)
        if len(predictions)!=len(images): raise ValueError('Orientation detector output count mismatch')
        start=time.perf_counter(); predictions=copy.deepcopy(predictions)
        for regions,decision in zip(predictions,decisions):
            for region in regions:
                region['bbox']=inverse_bbox(region['bbox'],decision['correction_angle'])
                if 'polygon' in region:
                    region['polygon']=[list(inverse_point(x,y,decision['correction_angle'])) for x,y in region['polygon']]
        map_ms=1000*(time.perf_counter()-start)
        self.last_image_metadata=[{'orientation':decision} for decision in decisions]
        return predictions,dict(timings,orientation_ms=classify_ms,orientation_rotate_ms=rotate_ms,orientation_inverse_map_ms=map_ms)

    def memory(self): return self.base.memory()
