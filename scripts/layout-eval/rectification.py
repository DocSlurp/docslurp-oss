"""Optional image-only light-paper boundary rectification experiment.

No page labels, filenames, source transforms or corpus annotations enter this
module. It abstains on border-filling pages and uncertain/no quadrilaterals.
This is a measured candidate, not a general camera-document guarantee.
"""
import copy
import math
import time


def order_quad(points):
    import numpy as np
    points=np.asarray(points,dtype=np.float32).reshape(4,2)
    center=points.mean(axis=0)
    order=np.argsort(np.arctan2(points[:,1]-center[1],points[:,0]-center[0]))
    points=points[order]
    points=np.roll(points,-int(np.argmin(points.sum(axis=1))),axis=0)
    # TL,TR,BR,BL; reject degeneracy rather than invent a crop.
    first,second=points[1]-points[0],points[2]-points[1]
    if abs(float(first[0]*second[1]-first[1]*second[0]))<1:
        raise ValueError('Degenerate page quadrilateral')
    return points


def find_page_quad(image,max_edge=768,minimum_area=.30):
    import cv2
    import numpy as np
    if max_edge<128: raise ValueError('Boundary probe edge must be at least128')
    array=np.asarray(image.convert('RGB'))
    scale=min(1.,max_edge/max(image.size))
    small=cv2.resize(array,(max(1,round(image.width*scale)),max(1,round(image.height*scale))),interpolation=cv2.INTER_AREA)
    height,width=small.shape[:2]
    hsv=cv2.cvtColor(small,cv2.COLOR_RGB2HSV)
    light=(hsv[:,:,1]<75)&(hsv[:,:,2]>150)
    perimeter=np.concatenate((light[0,:],light[-1,:],light[:,0],light[:,-1]))
    if perimeter.mean()>.88:
        return None,{'accepted':False,'reason':'light-page-fills-border'}
    gray=cv2.cvtColor(small,cv2.COLOR_RGB2GRAY)
    blur=cv2.GaussianBlur(gray,(5,5),0)
    edges=cv2.Canny(blur,50,150)
    edges=cv2.morphologyEx(edges,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8),iterations=2)
    masks=[('edges',edges),('light-neutral',(light.astype(np.uint8)*255))]
    candidates=[]
    for method,mask in masks:
        contours,_=cv2.findContours(mask,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
        for contour in sorted(contours,key=cv2.contourArea,reverse=True)[:40]:
            if cv2.contourArea(contour)<minimum_area*width*height: continue
            hull=cv2.convexHull(contour)
            perimeter=cv2.arcLength(hull,True)
            for epsilon in (.015,.025,.04):
                approx=cv2.approxPolyDP(hull,epsilon*perimeter,True)
                if len(approx)!=4 or not cv2.isContourConvex(approx): continue
                quad=order_quad(approx[:,0,:])
                area=abs(cv2.contourArea(quad))/(width*height)
                if not minimum_area<=area<.97: continue
                inside=np.zeros((height,width),dtype=np.uint8)
                cv2.fillConvexPoly(inside,quad.astype(np.int32),1)
                neutral=float(light[inside.astype(bool)].mean())
                if neutral<.45: continue
                lengths=[float(np.linalg.norm(quad[(i+1)%4]-quad[i])) for i in range(4)]
                if min(lengths)<min(width,height)*.12: continue
                score=area*(.5+.5*neutral)
                candidates.append((score,quad/scale,{'accepted':True,'method':method,'quad_area_fraction':area,'light_neutral_fraction':neutral}))
    if not candidates: return None,{'accepted':False,'reason':'no-confident-light-paper-quad'}
    _,quad,diagnostics=max(candidates,key=lambda x:x[0])
    return quad,diagnostics


def rectify_image(image,max_edge=768):
    import cv2
    import numpy as np
    from PIL import Image
    quad,diagnostics=find_page_quad(image,max_edge)
    if quad is None: return image,None,diagnostics
    width=max(2,round((np.linalg.norm(quad[1]-quad[0])+np.linalg.norm(quad[2]-quad[3]))/2))
    height=max(2,round((np.linalg.norm(quad[3]-quad[0])+np.linalg.norm(quad[2]-quad[1]))/2))
    target=np.array([[0,0],[width-1,0],[width-1,height-1],[0,height-1]],dtype=np.float32)
    matrix=cv2.getPerspectiveTransform(quad.astype(np.float32),target)
    inverse=np.linalg.inv(matrix)
    warped=cv2.warpPerspective(np.asarray(image),(matrix),(width,height),flags=cv2.INTER_LINEAR,borderValue=(255,255,255))
    diagnostics.update(source_quad=quad.tolist(),rectified_size=[width,height],probe_max_edge=max_edge)
    return Image.fromarray(warped),inverse,diagnostics


def map_regions(regions,inverse,rectified_size,source_size):
    if inverse is None: return copy.deepcopy(regions)
    import cv2
    import numpy as np
    output=copy.deepcopy(regions)
    width,height=rectified_size; source_width,source_height=source_size
    for region in output:
        points=region.get('polygon')
        if points is None:
            x0,y0,x1,y1=region['bbox'];points=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
        pixels=np.array([[[x*width,y*height] for x,y in points]],dtype=np.float32)
        mapped=cv2.perspectiveTransform(pixels,inverse)[0]
        polygon=[[min(1.,max(0.,float(x)/source_width)),min(1.,max(0.,float(y)/source_height))] for x,y in mapped]
        if not all(math.isfinite(v) for p in polygon for v in p): raise ValueError('Nonfinite rectified geometry')
        region['polygon']=polygon
        region['bbox']=[min(x for x,y in polygon),min(y for x,y in polygon),max(x for x,y in polygon),max(y for x,y in polygon)]
    return output


class RectifiedDetector:
    def __init__(self,base,max_edge=768):
        self.base,self.max_edge=base,max_edge
        self.supported_labels=base.supported_labels
        self.metadata={'id':base.metadata['id'],'revision':base.metadata.get('revision','unknown'),'detector':base.metadata,
                       'rectification':{'method':'light-paper-quadrilateral-v1','probe_max_edge':max_edge,'abstains':True}}
        self.last_image_metadata=[]

    def predict(self,images,threshold=.3):
        start=time.perf_counter(); prepared=[rectify_image(image,self.max_edge) for image in images]
        preprocessing=1000*(time.perf_counter()-start)
        predictions,timings=self.base.predict([p[0] for p in prepared],threshold)
        start=time.perf_counter()
        mapped=[map_regions(regions,prepared[i][1],prepared[i][0].size,images[i].size) for i,regions in enumerate(predictions)]
        child=getattr(self.base,'last_image_metadata',[{} for _ in images])
        self.last_image_metadata=[dict(child[i] if i<len(child) else {},rectification=p[2]) for i,p in enumerate(prepared)]
        return mapped,dict(timings,rectification_ms=preprocessing,rectification_mapping_ms=1000*(time.perf_counter()-start))

    def memory(self): return self.base.memory()
