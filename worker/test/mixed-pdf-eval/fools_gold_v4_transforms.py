"""Frozen v4 operations and measured execution; no source-file input routes."""
import copy
from io import BytesIO
import math
from pathlib import Path

import fitz
import numpy as np
import pikepdf
from PIL import Image, ImageEnhance, ImageFilter

from fools_gold_v4_common import *
from fools_gold_v4_native import render_native
from fools_gold_v4_check import operator_scan, pdf_profile, render_diff


def fitz_save(doc,path):
    """Deterministic intermediate writer identity; do not restore old Producer."""
    meta=doc.metadata or {}
    meta['producer']='PyMuPDF '+fitz.VersionBind
    doc.set_metadata({k:v for k,v in meta.items() if k in ['title','author','subject','keywords','creator','producer','creationDate','modDate']})
    save(path,doc.tobytes(garbage=4,deflate=True,no_new_id=True))


def scan_geometry(dpi,skew):
    w=math.ceil(612*dpi/72);h=math.ceil(792*dpi/72)
    blank=Image.new('L',(w,h));expanded=blank.rotate(-skew,resample=Image.Resampling.BICUBIC,expand=True,fillcolor=255)
    ew,eh=expanded.size;scale=min(604/ew,784/eh)
    x=(612-ew*scale)/2;y=(792-eh*scale)/2
    angle=math.radians(skew);c=math.cos(angle);s=math.sin(angle);d=dpi/72
    m=[scale*d*c,scale*d*s,-scale*d*s,scale*d*c,
       x+scale*(ew/2-c*w/2+s*h/2),y+scale*(eh/2-s*w/2-c*h/2)]
    return dict(inputPixels=[w,h],rasterPixels=[ew,eh],placement=[x,y,x+ew*scale,y+eh*scale],affine=m)


def operation(pid,index,kind,blocks,bbox,seed,parameters=None):
    p=dict(id=f'{pid}.op{index:02d}.{kind}',kind=kind,pageId=pid,blockIds=blocks,inputBboxPt=bbox,outputBboxPt=bbox,
           affine=IDENTITY,clipPolygonPt=box_polygon([0,0,612,792]),dpi=None,skewDegrees=0,blurSigmaPixels=0,
           jpegQuality=None,contrastMultiplier=1,noiseSigma255=0,backgroundRgb=[255,255,255],
           tool='PyMuPDF',version=fitz.VersionBind,seed=seed)
    if parameters:p.update(parameters)
    return p


def plans_for_family(spec,family,authoring,base_hash):
    fid=family['familyId'];seed=family['transformSeed'];layout=layout_for(spec,family)
    rank=sorted([p['id'] for p in authoring['pages']],key=lambda pid:sha(canonical([seed,pid,'hard-rank'])))
    result=[];section_k=round(family['sectionRasterShare']*5)
    for hard in spec['transform_contract']['hard_percent']:
        pages=[];hardids=rank[:hard//10]
        for page in authoring['pages']:
            pid=page['id'];pnum=page['number'];lookup={b['templateId']:b for b in page['blocks']};ops=[]
            def add(kind,suffixes,bbox,parameters=None):
                ops.append(operation(pid,len(ops),kind,[pid+'.'+s for s in suffixes],bbox,seed+pnum,parameters))
            hidden=[b for b in page['blocks'] if b['semanticClass']=='decoy']
            for b in hidden:add('occlusion',[b['templateId'], 'hidden.cover' if b['templateId']=='hidden.decoy' else 'overlay.cover'],b['bboxPt'])
            if pnum in [4,9]:add('outline',['body.1','body.2'],union_box(lookup[s]['bboxPt'] for s in ['body.1','body.2']),dict(tool='Ghostscript',version=run(['gs','--version']).stdout.decode().strip()))
            discussion=[s for s in lookup if s.startswith('discussion.')]
            if pnum in layout.get('mandatory_discussion_raster_pages',[2,5,8]):
                add('base-discussion-raster',discussion,lookup['discussion.frame']['bboxPt'],dict(dpi=150))
            selected=['g'+str((pnum-1+fid+j)%5) for j in range(section_k)]
            for gid in selected:
                suffixes=layout['semantic_regions'][gid];bbox=union_box(lookup[s]['bboxPt'] for s in suffixes)
                add('section-raster',suffixes,bbox,dict(dpi=150))
            if pid in hardids:
                index=(fid+pnum-1)%5;params=spec['transform_contract']['hard_scan_parameters']
                scan=dict(dpi=params['dpi_cycle'][index],skewDegrees=params['skew_degrees_cycle'][index],blurSigmaPixels=params['blur_sigma_pixels_cycle'][index],jpegQuality=params['jpeg_quality_cycle'][index],contrastMultiplier=params['contrast_multiplier_cycle'][index],noiseSigma255=params['noise_sigma_255_cycle'][index],tool='PyMuPDF + Pillow + numpy',version=fitz.VersionBind+' / '+__import__('PIL').__version__+' / '+np.__version__)
                geom=scan_geometry(scan['dpi'],scan['skewDegrees']);scan['affine']=geom['affine'];scan['outputBboxPt']=transformed_box([0,0,612,792],scan['affine'])
                add('hard-scan',[b['templateId'] for b in page['blocks']],[0,0,612,792],scan)
            rotation_degrees=90 if family['classId']=='P' and fid==0 and pnum==9 else 0
            if family['classId']!='P':rotation_degrees=90 if pnum==3 else 270 if pnum==7 else 0
            if rotation_degrees:add('page-rotation',[b['templateId'] for b in page['blocks']],[0,0,612,792],dict(affine=rotation(rotation_degrees),outputBboxPt=[0,0,792,612] if rotation_degrees in [90,270] else [0,0,612,792],clipPolygonPt=box_polygon([0,0,792,612] if rotation_degrees in [90,270] else [0,0,612,792])))
            add('storage-rewrite',[b['templateId'] for b in page['blocks']],[0,0,612,792],dict(tool='pikepdf + qpdf',version=__import__('pikepdf').__version__+' / '+run(['qpdf','--version']).stdout.decode().splitlines()[0]))
            pages.append(dict(pageId=pid,hardScan=pid in hardids,rotationDegrees=rotation_degrees,selectedSectionGroups=selected,operations=ops,outputPageSizePt=[792,612] if rotation_degrees in [90,270] else [612,792]))
        plan=freeze(dict(schema='mixed-pdf-transform-plan@4',authoringHash=authoring['authoringHash'],basePdfHash=base_hash,
                         hardPercent=hard,sectionRasterShare=family['sectionRasterShare'],selectedHardPageIds=hardids,hardPageRank=rank,pages=pages),'planHash')
        items=[]
        for page,pp in zip(authoring['pages'],pages):
            for b in page['blocks']:
                if b['semanticClass']!='decoy':continue
                cover=page['id']+('.hidden.cover' if b['templateId']=='hidden.decoy' else '.overlay.cover')
                items.append(dict(id=b['id']+'.exclusion',pageId=page['id'],blockId=b['id'],reason='fully-occluded-authoring-decoy' if b['templateId']=='hidden.decoy' else 'fully-occluded-auxiliary-row',authoredDisplayTextHash=sha(b['displayText'].encode()),glyphIds=[g['id'] for g in b['glyphs']],bboxPt=b['bboxPt'],occluderBlockIds=[cover],transformOperationIds=[op['id'] for op in pp['operations'] if op['kind']=='occlusion' and b['id'] in op['blockIds']],visibleGlyphCount=0,nativePresenceExpected=not pp['hardScan'],coverageFraction=1))
        exclusion=freeze(dict(schema='mixed-pdf-exclusion-plan@4',authoringHash=authoring['authoringHash'],planHash=plan['planHash'],items=items),'exclusionPlanHash')
        result.append((plan,exclusion))
    return result


def insert_region(page,evidence):
    """Opaque lossless pixels, clipped to only their own objects when needed.

    Soft masks change MuPDF's antialiasing for unrelated native text. Pixel-grid
    clipping avoids that global change. A 0.0001 pt placement correction keeps
    float32 image matrices on the intended 150-DPI grid; the actual rectangle
    and correction are recorded, not hidden by a diff threshold.
    """
    page.insert_image(evidence['placement'],stream=Path(evidence['path']).read_bytes(),keep_proportion=False)
    if evidence.get('alphaMaskPath'):
        mask=np.asarray(Image.open(evidence['alphaMaskPath']))>0
        pixel=.48;x0,y0=evidence['placement'][:2];commands=[];active={};rects=[]
        for y,row in enumerate(mask):
            edges=np.flatnonzero(np.diff(np.r_[False,row,False]));runs={(int(a),int(b)) for a,b in zip(edges[::2],edges[1::2])}
            for run,(start,end) in list(active.items()):
                if run not in runs:rects.append((run[0],start,run[1]-run[0],end-start));del active[run]
            for run in runs:
                if run in active:active[run]=(active[run][0],y+1)
                else:active[run]=(y,y+1)
        for run,(start,end) in active.items():rects.append((run[0],start,run[1]-run[0],end-start))
        for x,y,w,h in rects:commands.append(f'{x0+x*pixel:.6f} {792-y0-(y+h)*pixel:.6f} {w*pixel:.6f} {h*pixel:.6f} re')
        xref=page.get_contents()[-1];raw=page.parent.xref_stream(xref)
        page.parent.update_stream(xref,b'q\n'+('\n'.join(commands)+'\nW n\n').encode()+raw+b'\nQ\n')


def isolated_assets(spec,family,authoring,resolved,world,source_dir,plan):
    """Whole-producer omissions and isolated assets, never rectangular erasure."""
    omit=set();groups={};raster_ops={};outlines={}
    for page,pp in zip(authoring['pages'],plan['pages']):
        for op in pp['operations']:
            if op['kind'] in ['base-discussion-raster','section-raster']:
                omit.update(op['blockIds']);key=tuple(b.split('.',2)[2] for b in op['blockIds']);groups[key]=None;raster_ops[op['id']]=key
            if op['kind']=='outline':
                omit.update(op['blockIds']);outlines[page['id']]=op
    remaining=render_native(authoring,resolved,world,source_dir/'transform-native','remaining',omit=omit)
    sources={}
    for index,key in enumerate(groups):
        proof=render_native(authoring,resolved,world,source_dir/'isolated',f'group-{index:02d}',only=set(key));sources[key]=proof['pdf']
        from fools_gold_v4_check import compare_native
        not_selected={b['id'] for p in authoring['pages'] for b in p['blocks'] if b['templateId'] not in key}
        check=compare_native(authoring,proof['pdf'],not_selected);save(source_dir/f'isolated/group-{index:02d}-glyph-check.json',check)
        if not check['passed']:raise ValueError('Isolated region contains wrong/missing objects')
    outline_source=None
    if outlines:
        outline_native=render_native(authoring,resolved,world,source_dir/'isolated','outline-source',only={'body.1','body.2'})
        outline_source=source_dir/'isolated/outlined.pdf'
        command=['gs','-q','-dSAFER','-dBATCH','-dNOPAUSE','-sDEVICE=pdfwrite','-dCompatibilityLevel=1.7','-dNoOutputFonts','-sOutputFile='+str(outline_source),str(outline_native['pdf'])]
        run(command);save(source_dir/'isolated/outline-command.json',dict(command=command,version=run(['gs','--version']).stdout.decode().strip()))
    doc=fitz.open(remaining['pdf']);raster_evidence={};asset_dir=source_dir/'assets';asset_dir.mkdir()
    # Exact assets are shared across hard cases, preventing incidental variation.
    for index,(page,pp) in enumerate(zip(authoring['pages'],plan['pages'])):
        target=doc[index]
        raster_ids=set(b for op in pp['operations'] if op['kind'] in ['base-discussion-raster','section-raster'] for b in op['blockIds'])
        if page['id'] in outlines:
            op=outlines[page['id']]
            surviving=[b for b in op['blockIds'] if b not in raster_ids]
            if surviving:
                # Isolated outline PDF contains both paragraphs. If a section
                # overrides one, use an independently authored one-block asset.
                if len(surviving)==2:
                    with fitz.open(outline_source) as outlined:target.show_pdf_page(target.rect,outlined,index)
                else:
                    suffix={b.split('.',2)[2] for b in surviving};name='outline-'+str(index)
                    proof=render_native(authoring,resolved,world,source_dir/'isolated',name,only=suffix);dest=source_dir/'isolated'/(name+'-paths.pdf')
                    run(['gs','-q','-dSAFER','-dBATCH','-dNOPAUSE','-sDEVICE=pdfwrite','-dNoOutputFonts','-sOutputFile='+str(dest),str(proof['pdf'])])
                    with fitz.open(dest) as outlined:target.show_pdf_page(target.rect,outlined,index)
        for op in pp['operations']:
            if op['kind'] not in ['base-discussion-raster','section-raster']:continue
            key=raster_ops[op['id']];bbox=op['inputBboxPt'];pad=0 if op['kind']=='base-discussion-raster' else 2
            clip=fitz.Rect(bbox)+(-pad,-pad,pad,pad)
            with fitz.open(sources[key]) as isolated:
                pix=isolated[index].get_pixmap(dpi=150,alpha=False,clip=clip)
                alpha=isolated[index].get_pixmap(dpi=150,alpha=True,clip=clip) if op['kind']=='section-raster' else None
            epsilon=.0001
            rect=fitz.Rect(pix.x*72/150+epsilon,pix.y*72/150+epsilon,(pix.x+pix.width)*72/150+epsilon,(pix.y+pix.height)*72/150+epsilon)
            path=asset_dir/(op['id']+'.png');save(path,pix.tobytes('png'));mask_path=None
            if alpha:
                samples=np.frombuffer(alpha.samples,np.uint8).reshape(alpha.height,alpha.width,alpha.n);mask_path=asset_dir/(op['id']+'-alpha.png');buf=BytesIO();Image.fromarray(samples[:,:,-1]).save(buf,format='PNG');save(mask_path,buf.getvalue())
            raster_evidence[op['id']]=dict(path=str(path),sha256=file_hash(path),pixels=[pix.width,pix.height],placement=list(rect),selectedObjectIds=op['blockIds'],isolatedNativeHash=file_hash(sources[key]),alpha=False,alphaMaskPath=str(mask_path) if mask_path else None,alphaMaskHash=file_hash(mask_path) if mask_path else None,pixelGridCorrectionPt=[epsilon,epsilon],maskEncoding='binary clipping from nonzero 150-DPI alpha' if mask_path else None)
            insert_region(target,raster_evidence[op['id']])
    # No page-wide white cover is used. Native decoys remain in `remaining`.
    composite=source_dir/'composite-unrotated.pdf';fitz_save(doc,composite);doc.close()
    save(source_dir/'assets/evidence.json',raster_evidence)
    # Persist real intermediate PDFs for each global phase. Per-operation
    # execution snapshots below are extracted from these actual stage renders,
    # rather than inventing a hash of a prediction/evidence JSON object.
    stage_paths={};max_sections=max((len(pp['selectedSectionGroups']) for pp in plan['pages']),default=0)
    phases=[('outline',0),('discussion',0)]+[('section',n) for n in range(1,max_sections+1)]
    for phase,n in phases:
        active={};phase_omit=set()
        for page,pp in zip(authoring['pages'],plan['pages']):
            eligible=[o for o in pp['operations'] if o['kind']=='outline']
            if phase in ['discussion','section']:eligible +=[o for o in pp['operations'] if o['kind']=='base-discussion-raster']
            if phase=='section':eligible +=[o for o in pp['operations'] if o['kind']=='section-raster'][:n]
            active[page['id']]=eligible
            phase_omit.update(bid for o in eligible for bid in o['blockIds'])
        stage_name='phase-'+phase+str(n)
        proof=render_native(authoring,resolved,world,source_dir/'stages',stage_name+'-remaining',omit=phase_omit)
        stage_doc=fitz.open(proof['pdf'])
        for index,page in enumerate(authoring['pages']):
            ops=active[page['id']];native=stage_doc[index]
            raster_bids={bid for o in ops if o['kind'] in ['base-discussion-raster','section-raster'] for bid in o['blockIds']}
            for o in ops:
                if o['kind']=='outline':
                    surviving=[bid for bid in o['blockIds'] if bid not in raster_bids]
                    if not surviving:continue
                    if len(surviving)==2:path=outline_source
                    else:
                        suffix={b.split('.',2)[2] for b in surviving};stem='one-body-'+sha(canonical(sorted(suffix)))[:8]
                        path=source_dir/'isolated'/(stem+'-paths.pdf')
                        if not path.exists():
                            bproof=render_native(authoring,resolved,world,source_dir/'isolated',stem,only=suffix)
                            run(['gs','-q','-dSAFER','-dBATCH','-dNOPAUSE','-sDEVICE=pdfwrite','-dNoOutputFonts','-sOutputFile='+str(path),str(bproof['pdf'])])
                    with fitz.open(path) as vector:native.show_pdf_page(native.rect,vector,index)
                else:
                    evidence=raster_evidence[o['id']];insert_region(native,evidence)
        path=source_dir/'stages'/(stage_name+'.pdf');fitz_save(stage_doc,path);stage_doc.close()
        for pp in plan['pages']:
            for o in pp['operations']:
                if (phase=='outline' and o['kind']=='outline') or (phase=='discussion' and o['kind']=='base-discussion-raster') or (phase=='section' and o['kind']=='section-raster' and [q['id'] for q in pp['operations'] if q['kind']=='section-raster'].index(o['id'])==n-1):stage_paths[o['id']]=str(path)
    for pp in plan['pages']:
        for o in pp['operations']:
            if o['kind']=='occlusion':stage_paths[o['id']]=str(source_dir/'native.pdf')
    save(source_dir/'stages/operation-stages.json',stage_paths)
    diff=render_diff(source_dir/'native.pdf',composite,source_dir/'render-comparison',150)
    save(source_dir/'render-comparison.json',diff)
    if not diff['passed']:raise ValueError('Nonsemantic outline/section conversion exceeds strict 2% changed-pixel gate')
    return composite,raster_evidence,omit


def hard_image(page,op,path):
    pix=page.get_pixmap(dpi=op['dpi'],alpha=False);im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples)
    im=im.rotate(-op['skewDegrees'],resample=Image.Resampling.BICUBIC,expand=True,fillcolor=(255,255,255))
    im=im.filter(ImageFilter.GaussianBlur(op['blurSigmaPixels']));im=ImageEnhance.Contrast(im).enhance(op['contrastMultiplier'])
    if op['noiseSigma255']:
        rng=np.random.default_rng(op['seed']);a=np.array(im,dtype=np.float32);noise=rng.normal(0,op['noiseSigma255'],a.shape)
        im=Image.fromarray(np.clip(np.rint(a+noise),0,255).astype(np.uint8))
    out=BytesIO();im.save(out,format='JPEG',quality=op['jpegQuality'],subsampling=0,optimize=False,progressive=False)
    save(path,out.getvalue());geom=scan_geometry(op['dpi'],op['skewDegrees'])
    if list(im.size)!=geom['rasterPixels']:raise ValueError('unexpected expanded scan dimensions')
    return geom


def alpha_union(page,pp,assets):
    """Union of actual nonzero alpha support on the shared 150-DPI grid.

    Selected text-only images have transparent padding and gaps; counting their
    whole bounding rectangles would overstate raster support. Mandatory opaque
    discussion backgrounds and text-free images retain their real footprints.
    """
    scale=150/72;mask=np.zeros((1650,1275),dtype=bool);mandatory=np.zeros_like(mask)
    for op in pp['operations']:
        if op['id'] not in assets:continue
        a=assets[op['id']];image=Image.open(a['path']).convert('RGBA');alpha=np.asarray(Image.open(a['alphaMaskPath']))>0 if a.get('alphaMaskPath') else np.asarray(image)[:,:,3]>0
        x=round(a['placement'][0]*scale);y=round(a['placement'][1]*scale)
        xa=max(0,x);ya=max(0,y);xb=min(1275,x+image.width);yb=min(1650,y+image.height)
        mask[ya:yb,xa:xb] |= alpha[ya-y:yb-y,xa-x:xb-x]
        if op['kind']=='base-discussion-raster':mandatory[ya:yb,xa:xb] |= alpha[ya-y:yb-y,xa-x:xb-x]
    for b in page['blocks']:
        if b['role']=='text-free-image':
            x0,y0,x1,y1=b['bboxPt'];xa=max(0,round(x0*scale));xb=min(1275,round(x1*scale));ya=max(0,round(y0*scale));yb=min(1650,round(y1*scale));mask[ya:yb,xa:xb]=True;mandatory[ya:yb,xa:xb]=True
    return dict(rasterUnionAreaShare=float(mask.mean()),mandatoryImageArea=float(mandatory.sum())/scale**2,measurementDpi=150,alphaSupportThreshold=0)


def storage_rewrite(before,after,profile,world,history_path):
    intermediate=Path(before).parent/'pikepdf-intermediate.pdf'
    with pikepdf.open(before) as pdf:
        original={str(k):str(v) for k,v in pdf.docinfo.items()}
        pdf.docinfo['/Title']=world['title'];pdf.docinfo['/Author']=world['role']
        pdf.docinfo['/Producer']='pikepdf '+pikepdf.__version__+'; qpdf '+run(['qpdf','--version']).stdout.decode().splitlines()[0].split()[-1]
        date='D:'+world['date'].replace('-','')+"080000+00'00'"
        pdf.docinfo['/CreationDate']=date;pdf.docinfo['/ModDate']=date
        if '/Metadata' in pdf.Root:del pdf.Root.Metadata
        pdf.save(intermediate,static_id=True,object_stream_mode=pikepdf.ObjectStreamMode.disable,force_version='1.7')
    command=['qpdf','--static-id','--force-version='+str(profile['version']),'--object-streams='+('generate' if profile['object_streams'] else 'disable'),'--stream-data=compress','--compression-level=9']
    if profile['linearized']:command.append('--linearize')
    command +=[str(intermediate),str(after)];run(command)
    source=history_path.parents[2]/f'sources/{world["familyId"]:04d}'
    native_profile=load(source/'native-profile.json');native_proof=load(source/'producer-proof.json')
    history=dict(originalNativeInfo=native_profile['info'],nativeCommand=native_proof['command'],nativeOwner=native_proof['producer'],originalCompositeInfo=original,writers=[dict(tool='Ghostscript',version=run(['gs','--version']).stdout.decode().strip(),scope='body outline assets only'),dict(tool='PyMuPDF',version=fitz.VersionBind),dict(tool='pikepdf',version=pikepdf.__version__),dict(tool='qpdf',version=run(['qpdf','--version']).stdout.decode().splitlines()[0],command=command)],finalInfo=pdf_profile(after)['info'])
    save(history_path,history)
    return history


def build_case(root,spec,family,authoring,world,plan,exclusion,composite,assets):
    fid=family['familyId'];hard=plan['hardPercent'];caseid=f'mixed-source-{fid:04d}-hard-{hard:03d}';split=family['split']
    work=root/f'executions/{fid:04d}/stages-{hard:03d}';work.mkdir(parents=True)
    before=work/'before-storage.pdf';out=fitz.open();glyph_pages=[];execution_pages=[]
    with fitz.open(composite) as src:
        for index,(page,pp) in enumerate(zip(authoring['pages'],plan['pages'])):
            hardop=next((o for o in pp['operations'] if o['kind']=='hard-scan'),None)
            if hardop:
                image_path=work/f'p{index+1:02d}.jpg';geom=hard_image(src[index],hardop,image_path)
                target=out.new_page(width=612,height=792);target.insert_image(geom['placement'],stream=image_path.read_bytes(),keep_proportion=False)
            else:
                out.insert_pdf(src,from_page=index,to_page=index);target=out[-1];geom=None
            target.set_rotation(pp['rotationDegrees'])
            # Explicit per-glyph stages preserve authoring coordinates and final
            # display polygons. Every meaningful glyph must remain in bounds.
            glyphs=[];counts=dict(native=0,outlined=0,raster=0);visible_images=[];mandatory=[]
            raster_ids=set(b for o in pp['operations'] if o['kind'] in ['base-discussion-raster','section-raster'] for b in o['blockIds'])
            outline_ids=set(b for o in pp['operations'] if o['kind']=='outline' for b in o['blockIds'])
            for op in pp['operations']:
                if op['id'] in assets:
                    visible_images.append(assets[op['id']]['placement'])
                    if op['kind']=='base-discussion-raster':mandatory.append(assets[op['id']]['placement'])
            for b in page['blocks']:
                if b['role']=='text-free-image':visible_images.append(b['bboxPt']);mandatory.append(b['bboxPt'])
                for g in b['glyphs']:
                    encoding='raster' if hardop or b['id'] in raster_ids else 'outlined' if b['id'] in outline_ids or (b['assetHash'] and (b['formula'] or b['chart'])) else 'native'
                    if g['visible'] and not g['text'].isspace():counts[encoding]+=1
                    stages=[];poly=box_polygon(g['bboxPt'])
                    for operation in pp['operations']:
                        if operation['kind'] in ['hard-scan','page-rotation','storage-rewrite'] or b['id'] not in operation['blockIds']:continue
                        stages.append(dict(operationId=operation['id'],affine=operation['affine'],polygonPt=poly,bboxPt=g['bboxPt']))
                    if hardop:
                        poly=[affine_point(p,hardop['affine']) for p in poly];stages.append(dict(operationId=hardop['id'],affine=hardop['affine'],polygonPt=poly,bboxPt=union_box([[x,y,x,y] for x,y in poly])))
                    final=[affine_point(p,rotation(pp['rotationDegrees'])) for p in poly];bbox=union_box([[x,y,x,y] for x,y in final])
                    if not contains([0,0,*pp['outputPageSizePt']],bbox):raise ValueError('Lost glyph '+g['id'])
                    if pp['rotationDegrees']:stages.append(dict(operationId=next(o['id'] for o in pp['operations'] if o['kind']=='page-rotation'),affine=rotation(pp['rotationDegrees']),polygonPt=final,bboxPt=bbox))
                    stages.append(dict(operationId=next(o['id'] for o in pp['operations'] if o['kind']=='storage-rewrite'),affine=IDENTITY,polygonPt=final,bboxPt=bbox))
                    glyphs.append(dict(id=g['id'],text=g['text'],visible=g['visible'],encoding=encoding,authoringBboxPt=g['bboxPt'],stages=stages,displayPolygonPt=final,displayBboxPt=bbox,displayBboxNormalized=normalized(bbox,pp['outputPageSizePt'])))
            coverage=alpha_union(page,pp,assets);raster_share=coverage['rasterUnionAreaShare']
            if hardop:raster_share=area(geom['placement'])/(612*792)
            glyph_pages.append(dict(pageId=page['id'],sizePt=pp['outputPageSizePt'],readingOrder=page['readingOrder'],expectedMarkdown=page['expectedMarkdown'],sections=page['sections'],paragraphs=page['paragraphs'],blockIdsForSections=page['blockIdsForSections'],blockIdsForParagraphs=page['blockIdsForParagraphs'],blocks=page['blocks'],glyphTransforms=glyphs,metrics=dict(visibleGlyphCounts=counts,plannedSectionShare=family['sectionRasterShare'],realizedSectionShare=0 if hardop else family['sectionRasterShare'],selectedGroupsSupersededByHardScan=pp['selectedSectionGroups'] if hardop else [],rasterUnionAreaShare=raster_share,mandatoryImageArea=coverage['mandatoryImageArea'],areaMeasurementDpi=150,alphaSupportThreshold=0,sectionImageAreas=[assets[o['id']]['placement'] for o in pp['operations'] if o['kind']=='section-raster'])))
    meta=dict(title=world['title'],author=world['role'],creator='Writer' if family['producerPath']=='libreoffice-full' else 'ReportLab '+__import__('reportlab').Version,producer='PyMuPDF '+fitz.VersionBind,creationDate='D:'+world['date'].replace('-','')+"080000+00'00'",modDate='D:'+world['date'].replace('-','')+"080000+00'00'")
    out.set_metadata(meta);fitz_save(out,before);out.close()
    final=root/f'inputs/{split}/{caseid}.pdf';final.parent.mkdir(parents=True,exist_ok=True)
    profile=spec['file_profile']['case_storage_profiles']['profiles'][(hard//20+fid)%6]
    history_path=root/f'executions/{fid:04d}/{hard}-producer-history.json';history=storage_rewrite(before,final,profile,world,history_path)
    final_profile=pdf_profile(final);save(root/f'executions/{fid:04d}/{hard}-profile.json',final_profile)
    storage_diff=render_diff(before,final,work/'storage-diff',150);save(root/f'executions/{fid:04d}/{hard}-storage-comparison.json',storage_diff)
    if not storage_diff['passed']:raise ValueError('Storage rewrite changed pixels beyond strict 2% gate')
    # Execution hashes bind actual stage files. Per-op artifacts describe their
    # actual visual state; no future hash was inserted into the frozen plan.
    stage_chain={}
    stage_paths=load(root/f'sources/{fid:04d}/stages/operation-stages.json')
    for index,(page,pp) in enumerate(zip(authoring['pages'],plan['pages'])):
        previous=plan['basePdfHash'];opresults=[]
        for op in pp['operations']:
            e=copy.deepcopy(op);output=work/(op['id']+'.stage.pdf')
            evidence=dict(operationId=op['id'],previousStageHash=previous,planHash=plan['planHash'],actualCompositeHash=file_hash(composite),finalPdfHash=file_hash(final) if op['kind']=='storage-rewrite' else None,
                          asset=assets.get(op['id']),scanImageHash=file_hash(work/f'p{index+1:02d}.jpg') if op['kind']=='hard-scan' else None,
                          superseded=pp['hardScan'] and op['kind'] in ['outline','section-raster','base-discussion-raster'])
            stage_source=stage_paths.get(op['id'],str(final if op['kind']=='storage-rewrite' else before))
            with fitz.open(stage_source) as current:
                snapshot=fitz.open();snapshot.insert_pdf(current,from_page=index,to_page=index)
                if op['kind'] not in ['page-rotation','storage-rewrite']:snapshot[0].set_rotation(0)
                fitz_save(snapshot,output);snapshot.close()
            save(work/(op['id']+'.evidence.json'),evidence)
            e['inputStageHash']=previous;e['outputStageHash']=file_hash(output);previous=e['outputStageHash']
            e['rasterPixelSize']=assets[op['id']]['pixels'] if op['id'] in assets else scan_geometry(op['dpi'],op['skewDegrees'])['rasterPixels'] if op['kind']=='hard-scan' else [0,0]
            opresults.append(e)
        metrics=final_profile['pages'][index]
        execution_pages.append(dict(pageId=pp['pageId'],hardScan=pp['hardScan'],rotationDegrees=pp['rotationDegrees'],selectedSectionGroups=pp['selectedSectionGroups'],operations=opresults,outputPageSizePt=pp['outputPageSizePt'],nativeVisibleGlyphCount=glyph_pages[index]['metrics']['visibleGlyphCounts']['native'],imageCount=len(metrics['images']),vectorPathCount=metrics['paths']))
    execution=freeze(dict(schema='mixed-pdf-transform@4',authoringHash=authoring['authoringHash'],basePdfHash=plan['basePdfHash'],planHash=plan['planHash'],hardPercent=hard,sectionRasterShare=family['sectionRasterShare'],selectedHardPageIds=plan['selectedHardPageIds'],hardPageRank=plan['hardPageRank'],pages=execution_pages,outputPdfHash=file_hash(final),producerHistoryHash=file_hash(history_path)),'executionHash')
    save(root/f'executions/{fid:04d}/{hard}.json',execution)
    excluded=[]
    with fitz.open(final) as pdf:
        for item in exclusion['items']:
            e=copy.deepcopy(item);pindex=int(item['pageId'].split('.p')[-1])-1
            # Render unrotated local cover evidence, while preserving /Rotate.
            p=pdf[pindex];p.set_rotation(0);cover=next(b['bboxPt'] for b in authoring['pages'][pindex]['blocks'] if b['id'] in item['occluderBlockIds'])
            scan=next((o for o in plan['pages'][pindex]['operations'] if o['kind']=='hard-scan'),None)
            if scan:cover=transformed_box(cover,scan['affine'])
            pix=p.get_pixmap(dpi=150,clip=fitz.Rect(cover));crop=work/(item['id']+'.png');save(crop,pix.tobytes('png'));e['evidenceCropHash']=file_hash(crop);excluded.append(e)
    exclusions=freeze(dict(schema='mixed-pdf-exclusions@4',authoringHash=authoring['authoringHash'],planHash=plan['planHash'],items=excluded,exclusionPlanHash=exclusion['exclusionPlanHash']),'exclusionsHash');save(root/f'executions/{fid:04d}/{hard}-exclusions.json',exclusions)
    labels=freeze(dict(schema='mixed-pdf-labels@4',id=caseid,authoringHash=authoring['authoringHash'],planHash=plan['planHash'],executionHash=execution['executionHash'],exclusionsHash=exclusions['exclusionsHash'],pages=glyph_pages),'labelsHash');label_path=root/f'labels/{split}/{caseid}.json';save(label_path,labels)
    for name,rec in [('transform',execution),('exclusions',exclusions)]:validate_schema(rec,spec['immutable_records']['schemas'][name])
    return dict(id=caseid,familyId=fid,split=split,layoutId=family['layoutId'],classId=family['classId'],pdf=str(final.relative_to(root)),labels=str(label_path.relative_to(root)),sha256=file_hash(final),labelHash=file_hash(label_path),sourceLayoutHash=file_hash(root/f'sources/{fid:04d}/source-layout.json'),authoringHash=authoring['authoringHash'],worldHash=world['worldHash'],specHash=authoring['specHash'],planHash=plan['planHash'],executionHash=execution['executionHash'],exclusionPlanHash=exclusion['exclusionPlanHash'],exclusionsHash=exclusions['exclusionsHash'],hardPercent=hard,sectionRasterShare=family['sectionRasterShare'],realizedRasterUnionAreaShare=sum(p['metrics']['rasterUnionAreaShare'] for p in glyph_pages)/10,producerPath=family['producerPath'],producerVersion='LibreOffice 26.8.1.1' if family['producerPath']=='libreoffice-full' else 'ReportLab '+__import__('reportlab').Version,producerHistory=history,nativePdfHash=plan['basePdfHash'],pages=10,validationReports=[str((root/f'executions/{fid:04d}/{hard}-profile.json').relative_to(root)),str((root/f'executions/{fid:04d}/{hard}-storage-comparison.json').relative_to(root))])
