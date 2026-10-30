"""Producer adapter: immutable positions -> editable Writer owners/children."""
from __future__ import annotations
from pathlib import Path
from contract import FONTS, save, paint_order
from reportlab_native import plot_figure, side_pixels
from PIL import Image


def baseline_shift(kind,size,baseline):
    f=FONTS[kind];h=f.tt['hhea']
    native_height=(h.ascent-h.descent+h.lineGap)/f.upem*size
    return round((baseline-f.asc*size)*100/native_height)


def svg_paths(paths,box,color=(.08,.1,.12),width=.5):
    x0,y0,x1,y1=box
    rgb='rgb('+','.join(str(c*255) for c in color)+')'
    lines=''.join(f'<path d="M {a-x0:.10f},{b-y0:.10f} L {c-x0:.10f},{d-y0:.10f}" fill="none" stroke="{rgb}" stroke-width="{width}"/>' for a,b,c,d in paths)
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{x1-x0}pt" height="{y1-y0}pt" viewBox="0 0 {x1-x0} {y1-y0}">{lines}</svg>'.encode()


def make_scene(authoring,scenes,assets,permuted=False,calibration=None):
    assets=Path(assets);assets.mkdir(parents=True,exist_ok=True)
    pages=[]
    calibration=calibration or {}
    for ap,scene in zip(authoring['pages'],scenes):
        out=[];lookup={b['id']:b for b in ap['blocks']}
        _,order=paint_order(ap['blocks'],authoring['familyId'],ap['number'],permuted)
        for bid in order:
            b=lookup[bid];r=scene['resolved'][bid];box=b['containerPt'];tid=b['templateId']
            owner=ap['id']+'.discussion.frame' if tid.startswith('discussion.') and tid!='discussion.frame' else None
            common=dict(id=bid,box=box)
            if owner:common['owner']=owner
            if tid in ('discussion.frame','overlay.card','overlay.cover'):
                out.append(dict(common,background=[.88,.89,.9] if tid=='overlay.cover' else [.96,.97,.98],runs=[]));continue
            if r['table']:
                kind='mono' if tid=='matrix.table' else 'sans';size=b['fonts'][0]['sizePt']
                baseline=r['table']['rowHeight']*.8+(.3 if r['table']['ruled'] else 0)
                shift=baseline_shift(kind,size,baseline)
                out.append(dict(common,table=r['table'],runs=[dict(text='',font=kind,size=size,baselineShiftPct=shift)]));continue
            if b['chart']:
                path=assets/(bid+'.svg');fig=plot_figure(b,r)
                fig.savefig(path,format='svg',transparent=True,metadata={'Date':None});fig.clear()
                out.append(dict(common,graphic=str(path)));continue
            if tid=='side.image':
                path=assets/(bid+'.png');Image.fromarray(side_pixels(authoring['familyId'],ap['number'])).save(path)
                out.append(dict(common,graphic=str(path)));continue
            if tid=='footer.ornament':
                paths=[]
                for i in range(9):
                    x=60+i*45;y=[770,768,766][i%3];paths.append([x,y,x+30,y+5])
                path=assets/(bid+'.svg');save(path,svg_paths(paths,box,(.2,.4,.5),.8));out.append(dict(common,graphic=str(path)));continue
            # Single explicit run frames preserve mathematical baselines and index size.
            # The glyph envelope remains frozen; calibration is whole-font/leading based.
            for i,(text,x,y,kind,size,rot) in enumerate(r['runs']):
                leading=b['fonts'][0]['leadingPt'] if b['fonts'] else size*1.2
                top=y-FONTS[kind].asc*size
                width=FONTS[kind].width(text,size)
                shift=baseline_shift(kind,size,leading*.8)
                rb=[x,top,x+max(width+1,1),top+leading+2]
                runcommon=dict(id=bid+f'.run{i}',box=rb,leading=leading,
                    runs=[dict(text=text,font=kind,size=size,baselineShiftPct=shift)])
                if owner:runcommon['owner']=owner
                out.append(runcommon)
            if r['paths']:
                path=assets/(bid+'.rules.svg');save(path,svg_paths(r['paths'],box))
                out.append(dict(common,id=bid+'.rules',graphic=str(path)))
        pages.append(dict(number=ap['number'],blocks=out,paintOrder=[b['id'] for b in out]))
    return dict(schema='a6-writer-scene@1',authoringHash=authoring['authoringHash'],pages=pages)
