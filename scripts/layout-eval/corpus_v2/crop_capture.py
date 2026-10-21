#!/usr/bin/env python3
"""Source-derived partial scans; clipped glyphs never imply hidden full text."""
import copy
import json
from pathlib import Path
from PIL import Image
from capture import bounds, box_polygon, sha


def area(polygon):
    return abs(sum(p[0]*q[1]-q[0]*p[1] for p,q in zip(polygon,polygon[1:]+polygon[:1])))/2 if len(polygon)>2 else 0


def clip_polygon(polygon, crop):
    result=[list(p) for p in polygon]
    for axis,value,greater in [(0,crop[0],True),(0,crop[2],False),(1,crop[1],True),(1,crop[3],False)]:
        previous=result;result=[]
        if not previous:break
        for start,end in zip(previous[-1:]+previous[:-1],previous):
            inside_start=start[axis]>=value if greater else start[axis]<=value
            inside_end=end[axis]>=value if greater else end[axis]<=value
            if inside_start!=inside_end:
                t=(value-start[axis])/(end[axis]-start[axis]);result.append([start[0]+t*(end[0]-start[0]),start[1]+t*(end[1]-start[1])])
            if inside_end:result.append(end)
    return result


def contained(box,crop):
    return box[0]>=crop[0] and box[1]>=crop[1] and box[2]<=crop[2] and box[3]<=crop[3]


def clipped_item(item,crop):
    source_polygon=item.get('polygon',box_polygon(item['bbox']));clipped=clip_polygon(source_polygon,crop)
    if area(clipped)<=0:return None
    result=copy.deepcopy(item);polygon=[[x-crop[0],y-crop[1]] for x,y in clipped]
    result.update(source_bbox=item['bbox'],source_polygon=source_polygon,bbox=bounds(polygon),polygon=polygon,visibility=area(clipped)/area(source_polygon),truncated=area(clipped)<area(source_polygon)-1e-7)
    return result


def visible_lines(blocks,crop):
    visible=[]; receipts=[]
    for block in blocks:
        for text,box in zip(block['line_texts'],block['line_boxes']):
            overlap=clip_polygon(box_polygon(box),crop)
            state='fully-visible' if contained(box,crop) else 'partial-glyphs-untranscribed' if area(overlap)>0 else 'outside-crop'
            receipts.append({'source_text_block_id':block['id'],'source_line_bbox':box,'source_text':text,'visibility_state':state,'visible_text':text if state=='fully-visible' else None,'transcription_eligible':state=='fully-visible'})
            if state=='fully-visible':visible.append(text)
    return '\n'.join(visible),receipts


def crop_capture(source_image,reference_path,crop,output,capture_id):
    source_image,reference_path,output=map(Path,(source_image,reference_path,output));root=reference_path.parent.parent
    reference=json.loads(reference_path.read_text());source_path=root/'sources'/f"{reference['id']}.json";source=json.loads(source_path.read_text())
    if sha(source_path)!=reference['source_sha256']:raise ValueError('Changed source layout')
    for key in ('expected_markdown','prose_contract'):
        if sha(root/reference[key]['path'])!=reference[key]['sha256']:raise ValueError('Changed source contract')
    image=Image.open(source_image);w,h=image.size
    if len(crop)!=4 or any(v!=int(v) for v in crop) or not (0<=crop[0]<crop[2]<=w and 0<=crop[1]<crop[3]<=h):raise ValueError('Crop must be a nonempty integer rectangle within source image')
    regions=[];contracts=[];markdown=[];excluded=[]
    for original in reference['regions']:
        region=clipped_item(original,crop)
        if region is None:excluded.append(original['id']);continue
        blocks=[b for b in source['text_blocks'] if b['parent_region_id']==original['id']]
        text,receipts=visible_lines(blocks,crop)
        region['source_text']=original.get('text');region['text']=text or None
        region['attributes']['source_prose_contract']=copy.deepcopy(original['attributes'].get('prose_contract'))
        region['attributes']['prose_contract']={'scope':'visible-only complete glyph lines; consult capture visible-contract sidecar','partial_glyph_policy':'untranscribed; source text retained only as provenance'}
        region['attributes']['text_scope']='fully visible authored glyph lines only; partial glyph lines deliberately untranscribed'
        region['attributes']['source_line_boxes']=original['attributes'].get('line_boxes',[])
        region['attributes'].pop('line_boxes',None)
        if 'cells' in original['attributes']:
            cells=[];excluded_cells=[]
            for cell in original['attributes']['cells']:
                clipped=clipped_item(cell,crop)
                if clipped is None:excluded_cells.append({'row':cell['row'],'column':cell['column'],'source_bbox':cell['bbox']});continue
                cell_blocks=[b for b in blocks if contained(b['bbox'],cell['bbox'])]
                cell_text,cell_receipts=visible_lines(cell_blocks,crop)
                clipped.update(source_text=cell['text'],text=cell_text or None,text_visibility='fully-visible' if cell_receipts and all(r['transcription_eligible'] for r in cell_receipts) else 'partial-or-absent-untranscribed',text_contract=cell_receipts)
                cells.append(clipped)
            region['attributes']['cells']=cells;region['attributes']['excluded_source_cells']=excluded_cells
            complete_rows={c['row'] for c in cells if c['text_visibility']=='fully-visible'}-{c['row'] for c in cells if c['text_visibility']!='fully-visible'}
            for row in sorted(complete_rows):
                markdown.append('| '+' | '.join(str(c['text']).replace('|','\\|') for c in cells if c['row']==row)+' |')
                if row==0:markdown.append('| '+' | '.join('---' for c in cells if c['row']==row)+' |')
        elif text:markdown.append(('# ' if region['label']=='title' else '')+text)
        contracts.append({'region_id':region['id'],'geometry_visibility_fraction':region['visibility'],'geometry_truncated':region['truncated'],'visible_text':text or None,'lines':receipts})
        if 'annotationConfidence' in region:
            axis=region['annotationConfidence']['axes']
            axis['visibilityOcclusion']={'score':.5,'status':'source-derived','basis':['Exact source polygon clipped to authored integer raster crop; no independent visible-ink review'],'provenance':['deterministic-crop']}
            axis['textTranscription']={'score':.5,'status':'source-derived','basis':['Only complete source glyph lines included; clipped lines omitted, full source text retained separately'],'provenance':['deterministic-crop']}
        regions.append(region)
    output.mkdir(parents=True,exist_ok=True);expected=output/f'{capture_id}.visible.md';contract=output/f'{capture_id}.visible-contract.json';refpath=output/f'{capture_id}.reference.json';imagepath=output/f'{capture_id}.png'
    expected.write_text('\n\n'.join(markdown)+'\n');contract.write_text(json.dumps({'schema':'layout-crop-visible-transcription-v2','policy':'Full source text is provenance, not visible transcription. Only entirely visible glyph lines are eligible; partial lines deliberately untranscribed without guessing characters.','regions':contracts,'excluded_source_regions':excluded},indent=2)+'\n')
    metadata={'kind':'deterministic-partial-source-scan','source_id':reference['id'],'source_family':reference['id'],'document_id':source['document_id'],'page_number':source['page_number'],'source_image':str(source_image),'source_image_sha256':sha(source_image),'source_reference':str(reference_path),'source_reference_sha256':sha(reference_path),'source_layout':str(source_path),'source_layout_sha256':sha(source_path),'source_expected_markdown':{'path':str(root/reference['expected_markdown']['path']),'sha256':reference['expected_markdown']['sha256']},'crop_box_source_pixels':crop,'source_to_capture':[[1,0,-crop[0]],[0,1,-crop[1]],[0,0,1]],'excluded_source_regions':excluded,'review_status':'awaiting-visual-review-not-benchmark-admitted'}
    confidence=copy.deepcopy(reference.get('annotation_confidence',{'evidence':{}}))
    confidence['evidence']['deterministic-crop']={'actor':'partial scan generator','actorType':'tool','model':None,'method':'Sutherland-Hodgman polygon clipping to exact integer source crop; complete authored glyph-line eligibility checks','scope':'Source-derived mathematical clipping, not independent pixel transcription review','independentOfAuthor':False}
    confidencepath=output/f'{capture_id}.confidence.json';confidence['receipt_path']=str(confidencepath)
    confidencepath.write_text(json.dumps({'schema':'layout-crop-confidence-v2','annotation_confidence':confidence,'regions':[{'id':r['id'],'annotationConfidence':r.get('annotationConfidence')} for r in regions]},indent=2)+'\n')
    result={**copy.deepcopy(reference),'annotation_confidence':confidence,'schema':'layout-crop-reference-v2','id':capture_id,'image':{'width':crop[2]-crop[0],'height':crop[3]-crop[1]},'regions':regions,'expected_markdown':{'path':str(expected),'sha256':sha(expected),'scope':'visible-only-complete-glyph-lines'},'prose_contract':{'path':str(contract),'sha256':sha(contract),'scope':'visible-only-transcription-with-source-line-provenance'},'capture':metadata,'ground_truth':{**reference['ground_truth'],'transcription_scope':'visible-only; omitted clipped glyph lines are not known absent prose'}}
    refpath.write_text(json.dumps(result,indent=2)+'\n')
    image.crop(crop).save(imagepath)
    row={'id':capture_id,'image_path':str(imagepath),'reference_path':str(refpath),'width':result['image']['width'],'height':result['image']['height'],'regions':regions,'metadata':metadata,'split':'pilot-review'}
    (output/f'{capture_id}.row.json').write_text(json.dumps(row,indent=2)+'\n');return row
