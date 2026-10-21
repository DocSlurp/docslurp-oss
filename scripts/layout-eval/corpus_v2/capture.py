#!/usr/bin/env python3
"""Deterministic synthetic photographic print composites with invertible geometry.

Scene plates are generated illustrations, not evidence of a real camera capture.
The annotated source is projected into an explicitly calibrated planar print area;
curled paper edges outside that area are scene context, not document coordinates.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def homography(source, target):
    a, b = [], []
    for (x, y), (u, v) in zip(source, target):
        a.extend([[x,y,1,0,0,0,-u*x,-u*y], [0,0,0,x,y,1,-v*x,-v*y]])
        b.extend([u,v])
    return np.append(np.linalg.solve(np.array(a), np.array(b)), 1).reshape(3,3)


def project(points, matrix):
    p = np.column_stack([np.asarray(points, dtype=float), np.ones(len(points))]) @ matrix.T
    return (p[:,:2] / p[:,2:]).tolist()


def box_polygon(box):
    x0,y0,x1,y1 = box
    return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]


def bounds(points):
    p = np.asarray(points)
    return [float(p[:,0].min()),float(p[:,1].min()),float(p[:,0].max()),float(p[:,1].max())]


def transform_geometry(value, matrix):
    """Map every nested cell/line bbox; retain source geometry explicitly."""
    if isinstance(value, list):
        return [transform_geometry(v, matrix) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k:transform_geometry(v,matrix) for k,v in value.items() if k not in ('bbox','polygon','line_boxes')}
    if 'bbox' in value:
        polygon = project(value.get('polygon',box_polygon(value['bbox'])),matrix)
        out.update(source_bbox=value['bbox'], source_polygon=value.get('polygon',box_polygon(value['bbox'])), bbox=bounds(polygon), polygon=polygon)
    elif 'polygon' in value:
        out.update(source_polygon=value['polygon'], polygon=project(value['polygon'],matrix))
    if 'line_boxes' in value:
        out['source_line_boxes'] = value['line_boxes']
        out['line_polygons'] = [project(box_polygon(b),matrix) for b in value['line_boxes']]
        out['line_boxes'] = [bounds(p) for p in out['line_polygons']]
    return out


def visible_fraction(polygon, occlusion, size):
    mask = Image.new('L',size)
    ImageDraw.Draw(mask).polygon([tuple(p) for p in polygon],fill=255)
    p = np.asarray(mask)>0
    return float((255-np.asarray(occlusion)[p]).sum()/(255*p.sum())) if p.any() else 0.0


def validate_quad(quad, size):
    points=np.asarray(quad,dtype=float)
    if points.shape!=(4,2) or not np.isfinite(points).all():
        raise ValueError('Print quad must contain four finite corner coordinates')
    if np.any(points<0) or np.any(points>np.array(size)):
        raise ValueError('Print quad outside scene: clipping visibility is not calibrated')
    edge=np.roll(points,-1,axis=0)-points
    cross=edge[:,0]*np.roll(edge,-1,axis=0)[:,1]-edge[:,1]*np.roll(edge,-1,axis=0)[:,0]
    if not (np.all(cross>1e-6) or np.all(cross< -1e-6)):
        raise ValueError('Print quad must be convex and ordered without folds')


def compose(source_image, reference_path, scene_path, calibration_path, output, capture_id):
    source_image,reference_path,scene_path,calibration_path,output = map(Path,(source_image,reference_path,scene_path,calibration_path,output))
    reference=json.loads(reference_path.read_text()); calibration=json.loads(calibration_path.read_text())
    source_root=reference_path.parent.parent
    # Source text and label contracts must exist before the first transformed raster.
    for key in ('expected_markdown','prose_contract'):
        contract=reference.get(key)
        if not contract or sha(source_root/contract['path'])!=contract['sha256']:
            raise ValueError(f'Missing or changed source {key}; capture refused')
    source_path=source_root/'sources'/f"{reference['id']}.json"
    source_layout=json.loads(source_path.read_text())
    if sha(source_path)!=reference['source_sha256']:
        raise ValueError('Source layout changed after reference creation')
    source=Image.open(source_image).convert('RGB'); scene=Image.open(scene_path).convert('RGB')
    if source.size!=(reference['image']['width'],reference['image']['height']):
        raise ValueError('Source image/reference dimensions disagree')
    if list(scene.size)!=calibration['scene_size']:
        raise ValueError('Scene calibration dimensions disagree')
    if sha(scene_path)!=calibration['scene_sha256']:
        raise ValueError('Scene does not match calibrated plate')
    w,h=source.size; quad=calibration['print_quad']; validate_quad(quad,scene.size)
    matrix=homography([[0,0],[w,0],[w,h],[0,h]],quad)
    inverse=np.linalg.inv(matrix); inverse/=inverse[2,2]
    occlusion=Image.new('L',scene.size)
    # Manual silhouette is calibrated against visible hand boundaries in this plate.
    for polygon in calibration.get('occlusion_polygons',[]):
        ImageDraw.Draw(occlusion).polygon([tuple(p) for p in polygon],fill=255)
    occlusion=occlusion.filter(ImageFilter.GaussianBlur(calibration.get('occlusion_feather_px',0.6)))
    transformed=copy.deepcopy(reference)
    transformed.update(schema='layout-photographic-composite-reference-v2',id=capture_id,image={'width':scene.width,'height':scene.height},regions=transform_geometry(reference['regions'],matrix))
    transformed['annotation_confidence']=copy.deepcopy(reference.get('annotation_confidence',{'evidence':{}}))
    transformed['annotation_confidence']['evidence']['capture-calibration']={'actor':'capture composition agent','actorType':'agent','model':None,'method':'Manual four-corner inset print-area calibration and hand silhouette, visually inspected composite overlay','scope':'Physical appearance alignment estimate; exact homography arithmetic is not independent physical ground truth','independentOfAuthor':False}
    for region in transformed['regions']:
        if 'annotationConfidence' in region:
            region['source_annotationConfidence']=copy.deepcopy(region['annotationConfidence'])
            axes=region['annotationConfidence']['axes']
            axes['geometry']={'score':.75,'status':'agent-visually-checked','basis':['Manual print-area corner calibration and projected overlay checked; not independently reviewed physical geometry'],'provenance':['capture-calibration']}
            axes['visibilityOcclusion']={'score':.5,'status':'estimated','basis':['Raster-area visibility from manually traced hand silhouette; silhouette is approximate physical coverage'],'provenance':['capture-calibration']}
        region['visibility']=visible_fraction(region['polygon'],occlusion,scene.size)
        region['attributes']['capture_transcription_scope']='Full authored source text retained for provenance; hand coverage is not character-level transcription masking; do not score as visible-only prose'
        region['attributes']['coordinate_space']='capture-pixels; source_* fields retain authored page pixels'
        region['attributes']['occlusion_policy']='full projected polygon retained; visibility is unoccluded raster area fraction; no hidden text deletion'
    transformed['capture']={'kind':'synthetic-photographic-print-composite','source_id':reference['id'],'source_family':reference['id'],'document_id':source_layout['document_id'],'page_number':source_layout['page_number'],'source_image':str(source_image),'source_image_sha256':sha(source_image),'source_reference':str(reference_path),'source_reference_sha256':sha(reference_path),'source_layout':str(source_path),'source_layout_sha256':sha(source_path),'scene':str(scene_path),'scene_sha256':sha(scene_path),'calibration':calibration,'source_to_capture':matrix.tolist(),'capture_to_source':inverse.tolist(),'geometry_policy':'exact planar print quad; visible paper edge curl is scene context outside print quad','illumination':'multiplicative RGB from blank paper plate; retained paper texture and hand shadows','source_expected_markdown':str(source_root/reference['expected_markdown']['path']),'source_prose_contract':str(source_root/reference['prose_contract']['path']),'review_status':'awaiting-visual-review-not-benchmark-admitted'}
    transformed['ground_truth']['capture_prose_evaluation']='not-admitted; full source transcript is not a visible-only capture transcript'
    for key in ('expected_markdown','prose_contract'):
        transformed[key]={**reference[key],'path':str(source_root/reference[key]['path']),'coordinate_space':'authored-source-page; capture geometry in regions'}
    output.mkdir(parents=True,exist_ok=True)
    refpath=output/f'{capture_id}.reference.json'; maskpath=output/f'{capture_id}.occlusion.png'; imagepath=output/f'{capture_id}.png'
    confidencepath=output/f'{capture_id}.confidence.json'
    transformed['annotation_confidence']['receipt_path']=str(confidencepath)
    confidencepath.write_text(json.dumps({'schema':'layout-capture-confidence-v2','annotation_confidence':transformed['annotation_confidence'],'regions':[{'id':r['id'],'annotationConfidence':r.get('annotationConfidence'),'source_annotationConfidence':r.get('source_annotationConfidence')} for r in transformed['regions']]},indent=2)+'\n')
    # Persist geometry/occlusion BEFORE producing the capture image.
    occlusion.save(maskpath)
    transformed['capture']['occlusion_mask']={'path':str(maskpath),'sha256':sha(maskpath)}
    refpath.write_text(json.dumps(transformed,indent=2)+'\n')
    coeff=inverse.flatten()[:8].tolist()
    warped=source.transform(scene.size,Image.Transform.PERSPECTIVE,coeff,Image.Resampling.BICUBIC,fillcolor=(255,255,255))
    paper=Image.new('L',source.size,255).transform(scene.size,Image.Transform.PERSPECTIVE,coeff,Image.Resampling.BICUBIC,fillcolor=0)
    alpha=np.asarray(paper,dtype=np.float32)/255 * (1-np.asarray(occlusion,dtype=np.float32)/255)
    plate=np.asarray(scene,dtype=np.float32); ink=np.asarray(warped,dtype=np.float32)/255
    printed=plate*ink
    composite=plate*(1-alpha[:,:,None])+printed*alpha[:,:,None]
    Image.fromarray(np.clip(composite,0,255).astype(np.uint8)).save(imagepath)
    return {'id':capture_id,'image_path':str(imagepath),'reference_path':str(refpath),'width':scene.width,'height':scene.height,'regions':transformed['regions'],'split':'pilot-review','metadata':transformed['capture']}


def main():
    p=argparse.ArgumentParser()
    for name in ('source-image','reference','scene','calibration','output','id'):
        p.add_argument('--'+name,required=True)
    a=p.parse_args(); row=compose(a.source_image,a.reference,a.scene,a.calibration,a.output,a.id)
    (Path(a.output)/f'{a.id}.row.json').write_text(json.dumps(row,indent=2)+'\n')
    print(json.dumps({k:row[k] for k in ('id','image_path','reference_path')}))

if __name__=='__main__':
    main()
