"""Resolve and freeze complete E documents before invoking either producer."""
import base64
import copy
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
import json
from xml.sax.saxutils import escape
from jsonschema import Draft202012Validator
from support import *
from content import texts
from maths import formula,math_runs,parse,evaluate


def text_leaf(bid,kind,text,runs,box,rank,z,visible,primitives=()):
    glyphs=[];offset=0
    for literal,x,y,font,size,rot in runs:
        gg=FONTS[font].run(bid,literal,[x,y],size,offset,rot)
        glyphs.extend(gg);offset+=len(literal)
    primitive_boxes=[]
    for x,y,a,b in primitives:
        primitive_boxes.append([min(x,a)-.15,min(y,b)-.15,max(x,a)+.15,max(y,b)+.15])
    expected=union([g['expectedInkPt'] for g in glyphs]+primitive_boxes)
    assert contains(box,expected), ('ink outside fixed envelope',bid,box,expected)
    return dict(id=bid,kind=kind,containerPt=box,expectedSupportPt=expected,glyphs=glyphs,
        primitivePaths=[f'M{x},{y} L{a},{b} width=0.3' for x,y,a,b in primitives],
        semanticSerialization=text,visibleGlyphSequence=''.join(g['text'] for g in glyphs),
        lineBreakOffsets=[],readingRank=rank,zOrder=z,visible=visible)


def svg_asset(runs,paths,box,base_svg=None,colored_paths=()):
    """Full vector asset with real text; no reduced helper glyphs."""
    x,y,a,b=box
    pieces=[]
    if base_svg:
        import re
        # Retain matplotlib's namespace spelling. ElementTree's ns0 rewrite is
        # valid XML but this Writer SVG importer silently loses its plot group.
        # Input is exclusively our just-generated matplotlib SVG.
        raw=base_svg.decode('utf-8');match=re.search(r'<svg\b[^>]*>(.*)</svg>',raw,re.S)
        assert match,'Missing generated SVG root'
        pieces.append(match[1])
    for line in paths:
        xx,yy,aa,bb=line
        pieces.append(f'<path d="M{xx-x},{yy-y} L{aa-x},{bb-y}" fill="none" stroke="#14191f" stroke-width="0.3"/>')
    for line,color in colored_paths:
        xx,yy,aa,bb=line
        pieces.append(f'<path d="M{xx-x},{yy-y} L{aa-x},{bb-y}" fill="none" stroke="{color}" stroke-width="0.85"/>')
    for literal,xx,yy,kind,size,rot in runs:
        transform=f' transform="rotate({rot} {xx-x} {yy-y})"' if rot else ''
        pieces.append(f'<text x="{xx-x}" y="{yy-y}" font-family="{FONTS[kind].family}" font-size="{size}" fill="#14191f" xml:space="preserve"{transform}>{escape(literal)}</text>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="'+str(a-x)+'pt" height="'+str(b-y)+'pt" viewBox="0 0 '+str(a-x)+' '+str(b-y)+'">'+''.join(pieces)+'</svg>').encode()


def table_material(template,facts,family,mini=False):
    shape=template['table_shape']
    if mini:
        return [['Position','Mass','Unit']]+[[f'Gate {i+1}',str(facts['readings'][i]),'grams'] for i in range(3)]
    if family['classId']=='E2':
        rows=[['Record','Wet mass','','Rate/s'],['Item-ID','Span-s','Mass-g','Gain-g/s']]
        for i in range(6):
            mass=Decimal(facts['readings'][i])+Decimal(i)/10
            rate=(mass/Decimal(facts['durations'][i])).quantize(Decimal('.001'),rounding=ROUND_HALF_UP)
            rows.append([f'V{facts["number"]:02d}{i+1:02d}',f'{facts["durations"][i]}.000',f'{mass:.2f}',f'{rate:.3f}g/s'])
        return rows
    rows=[['Sector','Span','Reading','Rate/s']]
    for i in range(4):
        ratio=(Decimal(facts['readings'][i])/Decimal(facts['durations'][i])).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
        rows.append([f'V{facts["number"]:02d}{i+1:02d}',str(facts['durations'][i]),str(facts['readings'][i]),f'{ratio:04.1f}'])
    return rows


def chart_material(t,facts,bid):
    """Matplotlib owns the data plot; exact pinned-font labels are placed by recipe."""
    import matplotlib
    matplotlib.use('Agg')
    matplotlib.rcParams.update({'svg.fonttype':'none','svg.hashsalt':'a5-source-blind','font.family':'Liberation Sans'})
    from matplotlib.figure import Figure
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    box=t['placement_container_pt'];recipe=t['chart_shape']['placement_recipe'];plot=recipe['plot_rect_pt']
    w,h=box[2]-box[0],box[3]-box[1]
    fig=Figure(figsize=(w/72,h/72));FigureCanvasAgg(fig)
    ax=fig.add_axes([(plot[0]-box[0])/w,(box[3]-plot[3])/h,(plot[2]-plot[0])/w,(plot[3]-plot[1])/h])
    for j,data in enumerate(facts['chartSeries']):
        ax.plot(range(1,9),list(map(float,data)),color=['#284b63','#8d6548'][j],linewidth=.8,marker='o',markersize=1.5)
    ax.set_xlim(1,8);ax.set_ylim(0,100);ax.set_xticks(range(1,9));ax.set_yticks([0,25,50,75,100])
    ax.tick_params(labelbottom=False,labelleft=False,length=2,width=.4)
    for spine in ax.spines.values():spine.set_linewidth(.4)
    out=BytesIO();fig.savefig(out,format='svg',metadata={'Date':None,'Creator':'matplotlib'})
    size=8;font=FONTS['sans'];labels=[]
    def label(name,text,x,y,align='left',rotation=0):
        width=font.width(text,size)
        if align=='center':x-=width/2
        if align=='right':x-=width
        labels.append((name,text,[(text,x,y,'sans',size,rotation)]))
    label('title','Retention during inspection',*recipe['title_baseline_pt'],'center')
    label('axis-x','Position / step',*recipe['x_axis_baseline_pt'],'center')
    # The y-axis title rotates around its independently fixed visual center.
    cx,cy=recipe['y_axis_center_pt'];word='Retained mass / g';adv=font.width(word,8)
    # Rotation=270 in top-left coordinates proceeds upward. Its ink center is
    # offset from the baseline by the font ascender/descender average.
    label('axis-y',word,cx+(font.asc+font.desc)*4,cy+adv/2,rotation=270)
    for i in range(8):label(f'tick-x-{i}',str(i+1),plot[0]+(plot[2]-plot[0])*i/7,recipe['x_tick_baseline_y_pt'],'center')
    for i,v in enumerate([0,25,50,75,100]):
        label(f'tick-y-{i}',str(v),recipe['y_tick_right_x_pt'],plot[3]-(plot[3]-plot[1])*v/100+(font.asc+font.desc)*4,'right')
    for i,name in enumerate(['First pass','Repeat pass']):label(f'legend-{i}',name,recipe['legend_text_lefts_pt'][i],recipe['legend_baseline_y_pt'])
    runs=[run for _,_,rr in labels for run in rr]
    chart=dict(kind='line',data=[dict(name=name,xDecimals=[str(x) for x in range(1,9)],yDecimals=facts['chartSeries'][i],unitX='step',unitY='g') for i,name in enumerate(['First pass','Repeat pass'])],
        title=labels[0][1],axisTitles=[labels[1][1],labels[2][1]],ticks=[],legend=[],textGlyphIds=[],captionBlockId=bid+'.caption')
    colored=list(zip(recipe['legend_swatches_pt'],['#284b63','#8d6548']))
    return chart,labels,svg_asset(runs,[],box,out.getvalue(),colored),out.getvalue()


def resolve(spec,family,world,versions):
    layout=spec['enriched_derivatives'][family['classId']]['layouts'][family['layoutId']]
    pages=[];plans=[];resolved=[];misses=[]
    selected=sorted(range(1,11),key=lambda p:digest(f'e-stream-v1|{family["familyId"]}|{p}'))[:5]
    for facts in world['pages']:
        pid=f'f{family["familyId"]:04d}.p{facts["number"]:02d}';literal=texts(world,facts,family)
        blocks=[];leaves=[];placements={};tables={};figures={};draw={};cell_physical={};glyph_metric_ids={};image_assets={}
        for t in layout['blocks']:
            tid=t['id'];bid=pid+'.'+tid;box=t['placement_container_pt'];typ=t['typography'];ll=[]
            b=dict(id=bid,templateId=tid,role=t['role'],visible=t['visible'],bboxPt=box,bboxNormalized=[box[0]/612,box[1]/792,box[2]/612,box[3]/792],
                containerPt=box,zOrder=t['z_order'],readingRank=t['reading_rank'],displayText='',glyphs=[],fonts=[],cells=[],formula=None,chart=None,assetHash=None,
                semanticClass='quoted' if t['role']=='quoted-excerpt' else 'decoy' if not t['visible'] else 'ordinary' if typ else 'decoration')
            if not typ:
                leaf=dict(id=bid,kind='frame',containerPt=box,expectedSupportPt=box,glyphs=[],primitivePaths=[f'rect {box}'],semanticSerialization='',visibleGlyphSequence='',lineBreakOffsets=[],readingRank=None,zOrder=b['zOrder'],visible=b['visible'])
                ll=[leaf]
                if tid=='side.image':
                    import sys
                    sys.path.insert(0,str(CLEAN/'runtime'))
                    from fools_gold_v4_native import illustration
                    raw=illustration(world['seed']+facts['number']);b['assetHash']=digest(raw)
                    image_assets[bid]=dict(pngBase64=base64.b64encode(raw).decode(),sha256=digest(raw),generator='clean-inputs/runtime/fools_gold_v4_native.py:illustration',generatorSourceHash=digest((CLEAN/'runtime/fools_gold_v4_native.py').read_bytes()),seed=world['seed']+facts['number'],bboxPt=box)
            else:
                size=typ['font_size_pt'];kind=typ['font_class'];font=FONTS[kind];lead=typ['leading_pt'];rank=b['readingRank'];z=b['zOrder'];visible=b['visible']
                runs=[];paths=[]
                if 'table_shape' in t:
                    shape=t['table_shape'];data=table_material(t,facts,family,tid=='discussion.mini-table');cw=shape['column_widths_pt'];rh=shape['row_height_pt'];padding=shape['cell_padding_pt']
                    spans=[[s['row_start'],s['column_start'],s['row_end'],s['column_end']] for s in shape['merged_cells']]
                    printed=[];offset=0;phys=[]
                    for row,vals in enumerate(data):
                        prow=[];x=box[0]
                        for col,val in enumerate(vals):
                            if any(a<=row<=c and d<col<=e for a,d,c,e in spans):prow.append('');x+=cw[col];continue
                            span=next((s for s in spans if s[:2]==[row,col]),None)
                            physical=[x,box[1]+row*rh,x+sum(cw[col:(span[3]+1 if span else col+1)]),box[1]+(span[2]+1 if span else row+1)*rh]
                            cid=bid+f'.cell.r{row}.c{col}'
                            rr=[(val,x+padding,box[1]+row*rh+font.asc*size,kind,size,0)]
                            cell=text_leaf(cid,'cell',val,rr,physical,rank,z,visible)
                            # Unique stable glyph IDs are local to each cell; all
                            # are explicitly linked into the strict parent record.
                            ll.append(cell);runs+=rr;phys.append(dict(id=cid,physicalPt=physical))
                            unit='label' if row in shape['header_rows'] else ['identifier','s','g','g/s'][col] if tid=='matrix.table' else ['identifier','g','label'][col]
                            value=val.removesuffix('g/s') if row not in shape['header_rows'] and col==3 and family['classId']=='E2' else val
                            b['cells'].append(dict(row=row,column=col,rowSpan=1 if span is None else span[2]-row+1,columnSpan=1 if span is None else span[3]-col+1,displayText=val,value=value,unit=unit,bboxPt=cell['expectedSupportPt'],glyphIds=[g['id'] for g in cell['glyphs']],visible=visible))
                            sep=shape.get('separator') if col<3 else None
                            if sep:
                                sr=[(sep,x+padding+font.width(val,size),box[1]+row*rh+font.asc*size,kind,size,0)]
                                ll.append(text_leaf(cid+'.separator','text',sep,sr,physical,rank,z,visible));runs+=sr
                            prow.append(val+(sep or ''));x+=cw[col]
                        printed.append(prow)
                    b['displayText']='\n'.join(' '.join(row).rstrip() for row in printed)
                    tables[bid]=dict(data=printed,columnWidths=cw,rowHeight=rh,top=box[1],left=box[0],size=size,kind=kind,spans=spans,ruled=shape['border']!='none',padding=padding)
                    cell_physical[bid]=phys
                elif tid in ['math.rule','discussion.mini-math']:
                    if tid=='math.rule':
                        f=formula(family,facts);runs,paths=math_runs(f,box)
                    else:
                        result=Decimal(facts['readings'][1])-Decimal(facts['readings'][0]);expr='e = b - a';display=f'Offset {facts["number"]:02d}: '+expr
                        f=dict(display=display,latex='e = b - a',ast=parse(expr),variables=[dict(symbol=k,valueDecimal=str(v),unit='g') for k,v in [('a',facts['readings'][0]),('b',facts['readings'][1]),('e',result)]],valueDecimal=str(result),absoluteTolerance=0,constraints=['rounding=ROUND_HALF_UP; decimal_places=0'])
                        runs=[(display,box[0],box[1]+font.asc*size,kind,size,0)]
                    b['formula']=f;b['displayText']=f['display']
                    ll=[text_leaf(bid,'formula',f['display'],runs,box,rank,z,visible,paths)]
                    raw=svg_asset(runs,paths,box);b['assetHash']=digest(raw)
                    figures[bid]=dict(svgBase64=base64.b64encode(raw).decode(),bbox=box,assetHash=digest(raw),kind='math')
                elif tid=='chart':
                    chart,labels,raw,plotraw=chart_material(t,facts,bid);b['chart']=chart
                    for name,text,rr in labels:
                        leaf=text_leaf(bid+'.'+name,'chart-label',text,rr,box,rank,z,visible);ll.append(leaf);runs+=rr
                        if name.startswith('tick-'):
                            chart['ticks'].append(dict(axis=name.split('-')[1],valueDecimal=text,displayText=text,bboxPt=leaf['expectedSupportPt']))
                        if name.startswith('legend-'):
                            chart['legend'].append(dict(displayText=text,seriesIndex=int(name[-1]),bboxPt=leaf['expectedSupportPt']))
                    for i,left in enumerate(ll):
                        for right in ll[i+1:]:assert not area(intersect(left['expectedSupportPt'],right['expectedSupportPt'])),('chart label collision',left['id'],right['id'])
                    recipe=t['chart_shape']['placement_recipe'];plot=recipe['plot_rect_pt']
                    for series,values in enumerate(facts['chartSeries']):
                        points=[[plot[0]+(plot[2]-plot[0])*i/7,plot[3]-(plot[3]-plot[1])*float(v)/100] for i,v in enumerate(values)]
                        for i,(p,q) in enumerate(zip(points,points[1:])):
                            path=f'M{p[0]},{p[1]} L{q[0]},{q[1]} width=0.8'
                            support=[min(p[0],q[0])-.4,min(p[1],q[1])-.4,max(p[0],q[0])+.4,max(p[1],q[1])+.4]
                            ll.append(dict(id=bid+f'.series-{series}.segment-{i}',kind='primitive',containerPt=box,expectedSupportPt=support,glyphs=[],primitivePaths=[path],semanticSerialization=canonical(dict(series=series,fromPoint=i,toPoint=i+1,x=chart['data'][series]['xDecimals'][i:i+2],y=values[i:i+2])).decode(),visibleGlyphSequence='',lineBreakOffsets=[],readingRank=rank,zOrder=z,visible=visible))
                    for i,line in enumerate(recipe['legend_swatches_pt']):
                        p,q=line[:2],line[2:]
                        ll.append(dict(id=bid+f'.legend-swatch-{i}',kind='primitive',containerPt=box,expectedSupportPt=[min(p[0],q[0])-.425,p[1]-.425,max(p[0],q[0])+.425,q[1]+.425],glyphs=[],primitivePaths=[f'M{p[0]},{p[1]} L{q[0]},{q[1]} width=0.85'],semanticSerialization=canonical(dict(series=i,color=['#284b63','#8d6548'][i])).decode(),visibleGlyphSequence='',lineBreakOffsets=[],readingRank=rank,zOrder=z,visible=visible))
                    b['displayText']='\n'.join(text for name,text,rr in labels);b['assetHash']=digest(raw)
                    figures[bid]=dict(svgBase64=base64.b64encode(raw).decode(),bbox=box,assetHash=digest(raw),kind='chart')
                    draw[bid]=dict(runs=runs,paths=[],coloredPaths=list(zip(recipe['legend_swatches_pt'],['#284b63','#8d6548'])),plotSvg=base64.b64encode(plotraw).decode(),box=box)
                else:
                    text=literal.get(tid,'')
                    if tid=='math.constraint':
                        text=f'Range {facts["number"]:02d}: [{facts["lower"]}, {facts["upper"]}] grams; tolerance +/- 0.4 g'
                        if family['classId']=='E3' and family['layoutId']!='B':text=text.replace('grams','g').replace('Range','Bounds')
                    chosen=None
                    for count in range(t['budget']['lines'][0],t['budget']['lines'][1]+1):
                        try:
                            lines=split_lines(text,count,box[2]-box[0],font,size)
                            rr=[(line,box[0],box[1]+font.asc*size+i*lead,kind,size,0) for i,line in enumerate(lines)]
                            leaf=text_leaf(bid,'text',text,rr,box,rank,z,visible)
                            chosen=(lines,rr,leaf);break
                        except (ValueError,AssertionError):continue
                    if chosen is None:raise ValueError(('no pre-export support solution',bid,text,box))
                    lines,runs,leaf=chosen;leaf['lineBreakOffsets']=[sum(len(s)+1 for s in lines[:i]) for i in range(1,len(lines))]
                    ll=[leaf];b['displayText']='\n'.join(lines)
                    placements[bid]=dict(lines=lines,left=box[0],top=box[1],size=size,leading=lead,kind=kind)
                    if tid=='math.constraint':
                        b['formula']=dict(display=b['displayText'],latex=f'[{facts["lower"]},{facts["upper"]}] \\pm 0.4',ast=dict(op='and',args=[dict(op='interval',args=[dict(op='constant',valueDecimal=str(facts['lower'])),dict(op='constant',valueDecimal=str(facts['upper']))]),dict(op='tolerance',args=[dict(op='constant',valueDecimal='0.4')])]),variables=[],valueDecimal='0.4',absoluteTolerance=.4,constraints=['lower < upper','absolute tolerance > 0','rounding=ROUND_HALF_UP; decimal_places=1','unit=g'])
                if bid not in draw:draw[bid]=dict(runs=runs,paths=paths)
                for leaf in ll:
                    for glyph in leaf['glyphs']:
                        # Parent v4 schema cannot express null ink; degenerate
                        # spaces are marked with baseline only, never support.
                        ink=glyph['expectedInkPt'] or [*glyph['baselinePt'],*glyph['baselinePt']]
                        b['glyphs'].append(dict(id=glyph['id'],text=glyph['text'],bboxPt=ink,visible=visible,blockId=bid,logicalOffset=glyph['logicalOffset'],displayOrdinal=len(b['glyphs'])))
                        glyph_metric_ids[glyph['id']]=FONTS['mono' if glyph['fontHash']==FONTS['mono'].hash else 'sans'].glyph(glyph['text'])[1]
                b['bboxPt']=union(leaf['expectedSupportPt'] for leaf in ll)
                b['bboxNormalized']=[b['bboxPt'][0]/612,b['bboxPt'][1]/792,b['bboxPt'][2]/612,b['bboxPt'][3]/792]
                if b['chart']:b['chart']['textGlyphIds']=[g['id'] for g in b['glyphs']]
                b['fonts']=[dict(family=font.family,fileHash=font.hash,sizePt=size,leadingPt=lead,weight=400,embedded=True,subset=True)]
                semantic=normalized(b['displayText']);budget=t['budget']
                wc,cc=len(words(semantic)),len(semantic)
                if not budget['words'][0]<=wc<=budget['words'][1] or not budget['characters'][0]<=cc<=budget['characters'][1]:
                    misses.append(dict(block=bid,kind='budget',words=wc,characters=cc,expected=budget))
            leaves+=ll;blocks.append(b)
        order=[pid+'.'+tid for tid in layout['reading_order']];by_id={b['id']:b for b in blocks}
        # Preserve the inherited preauthored native decoy schedule independently.
        if facts['number'] in [3,8]:
            bid=pid+'.hidden.decoy';text=f'Closed inspection record {facts["number"]:02d}';box=[35,85.32,213,98]
            rr=[(text,35,85.32+FONTS['sans'].asc*9,'sans',9,0)]
            leaf=text_leaf(bid,'text',text,rr,box,None,1,False);leaves.append(leaf)
            b=copy.deepcopy(blocks[0]);b.update(id=bid,templateId='hidden.decoy',role='decoy',visible=False,bboxPt=leaf['expectedSupportPt'],containerPt=box,zOrder=1,readingRank=None,displayText=text,semanticClass='decoy',glyphs=[])
            for g in leaf['glyphs']:b['glyphs'].append(dict(id=g['id'],text=g['text'],bboxPt=g['expectedInkPt'] or [*g['baselinePt'],*g['baselinePt']],visible=False,blockId=bid,logicalOffset=g['logicalOffset'],displayOrdinal=len(b['glyphs'])))
            b['bboxNormalized']=[b['bboxPt'][0]/612,b['bboxPt'][1]/792,b['bboxPt'][2]/612,b['bboxPt'][3]/792];b['fonts']=[dict(family=FONTS['sans'].family,fileHash=FONTS['sans'].hash,sizePt=9,leadingPt=12,weight=400,embedded=True,subset=True)];blocks.append(b)
            placements[bid]=dict(lines=[text],left=35,top=85.32,size=9,leading=12,kind='sans');draw[bid]=dict(runs=rr,paths=[])
            cover=copy.deepcopy(blocks[0]);box=[31,81,217,102];cover.update(id=pid+'.hidden.cover',templateId='hidden.cover',role='occluder',visible=True,bboxPt=box,containerPt=box,bboxNormalized=[31/612,81/792,217/612,102/792],zOrder=2,readingRank=None,displayText='',glyphs=[],fonts=[],semanticClass='decoration');blocks.append(cover)
            leaves.append(dict(id=cover['id'],kind='frame',containerPt=box,expectedSupportPt=box,glyphs=[],primitivePaths=[f'rect {box}'],semanticSerialization='',visibleGlyphSequence='',lineBreakOffsets=[],readingRank=None,zOrder=2,visible=True))
        components,paint=paint_order(blocks,family['familyId'],facts['number'],facts['number'] in selected)
        pp=dict(schema='enriched-support-plan@5',classLayout=family['classId']+'-'+family['layoutId'],pageId=pid,worldHash=world['worldHash'],contractHash=digest((CLEAN/'spec-a5.json').read_bytes()),fontMetricEngine='fontTools cmap+hmtx+BoundsPen composite outlines',producerVersion=versions['producer'],leaves=leaves,canonicalReadingOrder=order,paintComponents=components,paintOrder=paint)
        freeze(pp,'planHash');Draft202012Validator(spec['enriched_resolution_plan_schema']).validate(pp);plans.append(pp)
        page=dict(id=pid,number=facts['number'],sizePt=[612,792],layoutContractId=pp['classLayout'],blocks=blocks,readingOrder=order,expectedMarkdown='\n\n'.join(by_id[bid]['displayText'] for bid in order),sections=[by_id[bid]['displayText'] for bid in order],paragraphs=[by_id[bid]['displayText'] for bid in order],blockIdsForSections=order,blockIdsForParagraphs=order,visibleGlyphCount=sum(1 for b in blocks for g in b['glyphs'] if g['visible'] and not g['text'].isspace()))
        pages.append(page);resolved.append(dict(id=pid,placements=placements,tables=tables,figures=figures,draw=draw,blocks=blocks,paintOrder=paint,cellPhysical=cell_physical,glyphMetricIds=glyph_metric_ids,imageAssets=image_assets))
        bodywords=sum(len(words(by_id[pid+'.body.'+str(i)]['displayText'])) for i in [1,2])
        limits=[140,180] if family['classId']=='E1' else [68,78]
        if not limits[0]<=bodywords<=limits[1]:misses.append(dict(page=pid,kind='combined-body-words',actual=bodywords,limits=limits))
    authored=freeze(dict(schema='mixed-pdf-authoring@4',familyId=family['familyId'],split=family['split'],classId=family['classId'],layoutId=family['layoutId'],specHash=digest((CLEAN/'spec-a5.json').read_bytes()),worldHash=world['worldHash'],producerPath=family['producerPath'],seed=family['worldSeed'],pages=pages),'authoringHash')
    Draft202012Validator(spec['immutable_records']['schemas']['authoring']).validate(authored)
    return authored,plans,dict(schema='a5-resolved-layout@1',authoringHash=authored['authoringHash'],pages=resolved),misses
