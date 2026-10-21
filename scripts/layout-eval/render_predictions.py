#!/usr/bin/env python3
"""Post-score development-only page overlays. No models, network or holdout reads."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import math
from pathlib import Path
import re
import time
from PIL import Image,ImageDraw,ImageFont
from scoring import match_boxes

SHOWCASES=('maple-lantern-1994-takeout-menu','food-feature-diner-mixed-light',
           'scientific-phase-rotated-90','rainfall-partial-table-bottom')
FONT='/usr/share/fonts/gsfonts/NimbusSans-Regular.otf'
COLORS={'TP':'#008663','FP':'#c12548','FN':'#bd6600'}


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def iso(value):return datetime.fromtimestamp(value,timezone.utc).isoformat()
def font(size):return ImageFont.truetype(FONT,size)


def read_selected(path,ids,variant,repeat):
    selected={}
    with Path(path).open() as stream:
        for line in stream:
            row=json.loads(line)
            if row['page_id'] not in ids or row['variant']!=variant or row['repeat']!=repeat:continue
            if row['page_id'] in selected:raise ValueError('Duplicate selected page/variant/repeat')
            selected[row['page_id']]=row
    return selected


def diagnostics(truth,predicted):
    pairs=match_boxes(truth,predicted,.5,class_aware=True)
    return {'tp':len(pairs),'fp':len(predicted)-len(pairs),'fn':len(truth)-len(pairs),
            'matches':[{'truth_index':ti,'prediction_index':pi,'iou':iou} for ti,pi,iou in pairs]},pairs


def annotate(image,regions,statuses,prefix,panel_width,supported=None):
    scale=panel_width/image.width;height=round(image.height*scale)
    canvas=image.resize((panel_width,height),Image.Resampling.LANCZOS).convert('RGB');d=ImageDraw.Draw(canvas)
    for index,(region,status) in enumerate(zip(regions,statuses)):
        box=region['bbox']
        if len(box)!=4 or not all(math.isfinite(v) and 0<=v<=1 for v in box) or box[0]>=box[2] or box[1]>=box[3]:
            raise ValueError('Invalid normalized diagnostic box')
        pixels=[box[0]*panel_width,box[1]*height,box[2]*panel_width,box[3]*height]
        color=COLORS[status];d.rectangle(pixels,outline=color,width=3)
        label=f'{prefix}{index:02d} {region["label"]} {status}'
        if prefix=='P':label+=f' {region.get("confidence",0):.2f}'
        elif supported is not None and region['label'] not in supported:label+=' UNSUPPORTED'
        # Labels can overlap in dense layouts; exact full index retained in JSON.
        b=d.textbbox((0,0),label,font=font(14));tw=b[2]+7;th=b[3]+6
        x=min(max(0,pixels[0]),max(0,panel_width-tw));y=max(0,pixels[1]-th)
        d.rectangle([x,y,x+tw,y+th],fill=color)
        d.text((x+3,y+1),label,font=font(14),fill='white')
    return canvas


def validate_reference(manifest_row,prediction):
    width,height=manifest_row['width'],manifest_row['height']
    reference=[dict(r,bbox=[v/s for v,s in zip(r['bbox'],(width,height,width,height))])
               for r in manifest_row['regions'] if r.get('visibility',1)>0]
    if len(reference)!=len(prediction['truth']):raise ValueError('Prediction truth count differs from frozen dev reference')
    for left,right in zip(reference,prediction['truth']):
        if left.get('id')!=right.get('id') or left['label']!=right['label'] or any(abs(a-b)>1e-8 for a,b in zip(left['bbox'],right['bbox'])):
            raise ValueError('Prediction reference differs from frozen dev reference')
    return reference


def render_page(manifest_row,prediction,image_path,output,metadata,supported,panel_width=850):
    actual=digest(image_path);expected=manifest_row.get('metadata',{}).get('image_sha256')
    if expected and actual!=expected:raise ValueError('Source raster differs from frozen manifest')
    if prediction.get('source_sha256') and prediction['source_sha256']!=actual:raise ValueError('Inference source raster differs from displayed raster')
    truth=validate_reference(manifest_row,prediction);predicted=prediction['regions']
    with Image.open(image_path) as opened:image=opened.convert('RGB')
    if image.size!=(manifest_row['width'],manifest_row['height']):raise ValueError('Source size mismatch')
    score,pairs=diagnostics(truth,predicted);ti={m[0] for m in pairs};pi={m[1] for m in pairs}
    left=annotate(image,truth,['TP' if i in ti else 'FN' for i in range(len(truth))],'G',panel_width,supported)
    right=annotate(image,predicted,['TP' if i in pi else 'FP' for i in range(len(predicted))],'P',panel_width)
    original=image.resize(left.size,Image.Resampling.LANCZOS)
    header=170;footer=120;gap=14;canvas=Image.new('RGB',(panel_width*3+gap*4,left.height+header+footer),'#14222b');d=ImageDraw.Draw(canvas)
    model=metadata.get('model',{});runtime=model.get('runtime') or model.get('detector',{}).get('runtime') or 'see JSON runtime provenance'
    precision=model.get('precision') or model.get('detector',{}).get('precision') or 'unrecorded'
    runtime=f'{runtime}/{precision}/batch{metadata.get("batch_size","?")}'
    title=f'{manifest_row["id"]} | {model.get("id","unrecorded model")} | {metadata.get("device","unknown device")}'
    d.text((gap,12),title,font=font(25),fill='#f0f5f5')
    d.text((gap,50),f'POST-SCORE DEV ERROR ANALYSIS | class-aware greedy IoU >= 0.50 | TP {score["tp"]} / FP {score["fp"]} / FN {score["fn"]}',font=font(22),fill='#b5dad3')
    d.text((gap,86),f'variant={prediction["variant"]}; repeat={prediction["repeat"]}; runtime={runtime}; inference error={prediction.get("error")}',font=font(18),fill='#edf0ed')
    for i,(panel,label) in enumerate([(original,'SOURCE RASTER'),(left,'REFERENCE: TP green / FN orange'),(right,'PREDICTION: TP green / FP red; confidence is model score')]):
        x=gap+i*(panel_width+gap);d.text((x,132),label,font=font(19),fill='white');canvas.paste(panel,(x,header))
    y=header+left.height+14
    d.text((gap,y),f'Source SHA256 {actual}',font=font(16),fill='#cbd4d5')
    d.text((gap,y+29),'Reference evidence-ordinal annotation confidence is separate from prediction confidence; no confidence weighting. All classes remain visible.',font=font(18),fill='#cbd4d5')
    d.text((gap,y+59),'Exact boxes, labels, unsupported classes, matches, source/provenance timestamps and full confidence details: adjacent JSON. No production readiness claim.',font=font(17),fill='#cbd4d5')
    canvas.save(output,optimize=True)
    return {'diagnostic':score,'source_image_sha256':actual,'image_dimensions':list(image.size),
        'unsupported_truth_labels':sorted({r['label'] for r in truth}-set(supported)) if supported is not None else None,
        'supported_labels':sorted(supported) if supported is not None else None,
        'truth':truth,'predictions':predicted,'inference_error':prediction.get('error'),
        'source_manifest_metadata':manifest_row.get('metadata',{}),
        'timestamp_policy':'File mtimes are filesystem modification times, not physical capture times or per-page inference timestamps.',
        'source_image_file_mtime_utc':iso(image_path.stat().st_mtime)}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',type=Path,required=True);p.add_argument('--predictions',type=Path,nargs='+',required=True)
    p.add_argument('--page-id',action='append');p.add_argument('--variant',default='original');p.add_argument('--repeat',type=int,default=0)
    p.add_argument('--output-dir',type=Path,required=True);p.add_argument('--panel-width',type=int,default=850)
    args=p.parse_args(argv)
    if args.output_dir.exists():raise ValueError('Refuse to overwrite diagnostic evidence')
    if not 400<=args.panel_width<=1600:raise ValueError('Panel width outside readable bounded range')
    manifest={r['id']:r for r in map(json.loads,args.manifest.read_text().splitlines())}
    # Refuse even a mixed full corpus manifest: this helper must not read holdout.
    if any(r.get('split')!='dev' for r in manifest.values()):raise ValueError('Only a strict dev-only manifest is accepted')
    selected=args.page_id or list(SHOWCASES)
    if set(selected)-set(manifest):raise ValueError('Requested page IDs absent from strict dev manifest')
    args.output_dir.mkdir(parents=True);records=[]
    for path in args.predictions:
        metadata_path=path.with_suffix('.metadata.json');metadata=json.loads(metadata_path.read_text())
        if metadata.get('split')!='dev':raise ValueError('Only development prediction outputs may be inspected')
        if metadata.get('manifest_sha256')!=digest(args.manifest):raise ValueError('Prediction manifest hash does not match strict dev manifest')
        summary_path=path.with_suffix('.summary.json');supported=None
        if summary_path.exists():supported=set(json.loads(summary_path.read_text())['summaries'][args.variant]['scores']['supported_labels'])
        rows=read_selected(path,set(selected),args.variant,args.repeat)
        for page_id in selected:
            if page_id not in rows:raise ValueError(f'Missing requested prediction {page_id} in {path}')
            safe=lambda v:re.sub(r'[^a-zA-Z0-9_.-]','_',v)
            stem=safe(path.stem)+'--'+safe(page_id)+'--'+safe(args.variant)+f'--r{args.repeat}'
            output=args.output_dir/(stem+'.png');source=Path(manifest[page_id]['image_path'])
            if not source.is_absolute():source=args.manifest.parent/source
            report=render_page(manifest[page_id],rows[page_id],source,output,metadata,supported,args.panel_width)
            report.update(schema='layout-postscore-dev-overlay-v1',created_utc=iso(time.time()),page_id=page_id,
                model_runtime_metadata=metadata,source_manifest_path=str(args.manifest),source_manifest_sha256=digest(args.manifest),
                prediction_path=str(path),prediction_sha256=digest(path),prediction_file_mtime_utc=iso(path.stat().st_mtime),
                prediction_run_start_utc=iso(metadata['started_unix']) if metadata.get('started_unix') else None,
                prediction_timestamp_per_page=None,prediction_variant=args.variant,prediction_repeat=args.repeat,
                overlay_path=str(output),overlay_sha256=digest(output),scope='post-score development diagnostics; not independent admission QA or heldout confirmation')
            output.with_suffix('.json').write_text(json.dumps(report,indent=2)+'\n')
            records.append({k:report[k] for k in ('page_id','diagnostic','overlay_path','overlay_sha256','unsupported_truth_labels')})
    (args.output_dir/'index.json').write_text(json.dumps(records,indent=2)+'\n')
    print(json.dumps({'overlays':len(records),'index':str(args.output_dir/'index.json')}))


if __name__=='__main__':main()
