"""Bounded deterministic quality variants; no independent document/layout claim."""
import copy,json
from pathlib import Path
import numpy as np
from PIL import Image,ImageEnhance,ImageFilter
from capture import sha,transform_geometry


def derive(imagepath,refpath,output,identifier,kind,parameter=None):
    imagepath,refpath,output=map(Path,(imagepath,refpath,output));ref=json.loads(refpath.read_text());image=Image.open(imagepath).convert('RGB');w,h=image.size
    matrix=np.eye(3);newsize=(w,h)
    if kind=='stored-pixel-clockwise-90':matrix=np.array([[0,-1,h],[1,0,0],[0,0,1]]);newsize=(h,w)
    elif kind=='low-resolution-max-edge':
        scale=parameter/max(w,h);newsize=(round(w*scale),round(h*scale));matrix=np.diag([newsize[0]/w,newsize[1]/h,1])
    elif kind not in ('gaussian-blur','digital-underexposure'):raise ValueError('Unsupported bounded quality operation')
    result=copy.deepcopy(ref);result.update(id=identifier,image={'width':newsize[0],'height':newsize[1]},regions=transform_geometry(ref['regions'],matrix))
    parent=ref.get('capture',{})
    native_id=parent.get('source_id',ref['id']);source_layout=parent.get('source_layout') or str(refpath.parent.parent/'sources'/f"{ref['id']}.json")
    layout=json.loads(Path(source_layout).read_text())
    metadata={**copy.deepcopy(parent),'kind':'deterministic-quality-derivative','source_id':native_id,'source_family':parent.get('source_family',native_id),'document_id':parent.get('document_id',layout['document_id']),'page_number':layout['page_number'],'parent_id':ref['id'],'parent_image':str(imagepath),'parent_image_sha256':sha(imagepath),'parent_reference':str(refpath),'parent_reference_sha256':sha(refpath),'quality_operation':{'kind':kind,'parameter':parameter,'input_size':[w,h],'output_size':list(newsize),'source_to_derivative':matrix.tolist(),'claim':'Factual deterministic construction parameters only; no independent physical lighting, optical blur or legibility measurement'},'review_status':'awaiting-visual-review-not-benchmark-admitted'}
    result['capture']=metadata;result['ground_truth']['quality_variant_transcription']='Parent source-presence transcript retained; no legibility or visible-character correctness claim from degradation'
    for region in result['regions']:
        region['attributes']['quality_variant_transcription']='Inherited source-presence transcript; blur/downsample/digital exposure is not a legibility annotation'
    for key in ('expected_markdown','prose_contract'):
        if key in result and not Path(result[key]['path']).is_absolute():result[key]['path']=str(refpath.parent.parent/result[key]['path'])
    output.mkdir(parents=True,exist_ok=True);confidencepath=output/f'{identifier}.confidence.json';referencepath=output/f'{identifier}.reference.json';outimage=output/f'{identifier}.png'
    if 'annotation_confidence' in result:
        result['annotation_confidence']['receipt_path']=str(confidencepath)
        result['annotation_confidence']['evidence']['quality-transform']={'actor':'quality derivative generator','actorType':'tool','model':None,'method':metadata['quality_operation'],'scope':'Deterministic pixel and coordinate transform; no new independent review or legibility evidence','independentOfAuthor':False}
    confidencepath.write_text(json.dumps({'schema':'layout-quality-confidence-v2','annotation_confidence':result.get('annotation_confidence'),'regions':[{'id':r['id'],'annotationConfidence':r.get('annotationConfidence')} for r in result['regions']]},indent=2)+'\n')
    referencepath.write_text(json.dumps(result,indent=2)+'\n')
    if kind=='stored-pixel-clockwise-90':image=image.transpose(Image.Transpose.ROTATE_270)
    elif kind=='low-resolution-max-edge':image=image.resize(newsize,Image.Resampling.LANCZOS)
    elif kind=='gaussian-blur':image=image.filter(ImageFilter.GaussianBlur(parameter))
    elif kind=='digital-underexposure':image=ImageEnhance.Brightness(image).enhance(parameter)
    image.save(outimage)
    row={'id':identifier,'image_path':str(outimage),'reference_path':str(referencepath),'width':newsize[0],'height':newsize[1],'regions':result['regions'],'metadata':metadata,'split':'pilot-review'};(output/f'{identifier}.row.json').write_text(json.dumps(row,indent=2)+'\n');return row
