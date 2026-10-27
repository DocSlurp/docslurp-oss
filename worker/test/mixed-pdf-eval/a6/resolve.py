"""Resolve literals, exact arithmetic, font support and native scenes before export."""
from __future__ import annotations
from decimal import Decimal, localcontext
from fractions import Fraction
import json
import math
from pathlib import Path
import re
from contract import *
from worlds import make_world
from prose import Author
from math_layout import math_runs, evaluate


def latex(node):
    op=node['op']
    if op=='symbol':
        parts=node['name'].split('_')
        return parts[0]+('_{'+parts[1]+'}' if len(parts)>1 else '')
    if op=='constant':return node['valueDecimal']
    a=[latex(n) for n in node['args']]
    if op=='divide':return r'\frac{'+a[0]+'}{'+a[1]+'}'
    if op=='power':return '{'+a[0]+'}^{'+a[1]+'}'
    return (' = ' if op=='equal' else ' - ' if op=='subtract' else ' + ' if op=='add' else r'\,').join(a)


def formula(family,page,mini=False):
    rows=page['observations'];value=lambda row,col:rows[row]['cells'][col]
    shape='mini' if mini else 'E2' if family['classId']=='E2' else SPEC['formula_shape_library'][(family['familyId']+page['number']-1)%5]['id']
    variables={}
    bindings={}
    def v(symbol,val,unit,cell=None):
        variables[symbol]=dict(valueDecimal=str(val),unit=unit)
        bindings[symbol]=cell or dict(kind='independent-calibration-parameter')
        return symbol
    mass=lambda i,s:v(s,value(i,1),'mg',dict(rowId=rows[i]['id'],column=1))
    if shape=='mini':
        mass(2,'a');mass(0,'b');expr='d = a-b';label='Net change';unit='mg'
    elif shape=='Q':
        mass(0,'a');v('t',value(0,2),'s',dict(rowId=rows[0]['id'],column=2));expr='r = a/t';label='Mass ratio';unit='mg/s'
    elif shape=='D':
        mass(0,'a');mass(1,'b');expr='r = (a-b)/b';label='Relative shift';unit='1'
    elif shape=='A':
        mass(0,'v');v('g',page['calibration']['g'],'1',dict(parameter='g'));v('h',page['calibration']['h'],'mg',dict(parameter='h'));expr='r = g*v+h';label='Affine response';unit='mg'
    elif shape=='P':
        mass(0,'v');v('u',page['calibration']['u'],'mg',dict(parameter='u'));v('g',page['calibration']['powerGain'],'mg',dict(parameter='powerGain'));v('n',page['calibration']['exponent'],'1',dict(parameter='exponent'));expr='r = g*(v/u)^n';label='Power response';unit='mg'
    else:
        selected=[0,2,len(rows)-1] if shape=='E2' else [0,len(rows)-1]
        nums=[];dens=[]
        for i,j in enumerate(selected):
            index=j+1 if shape=='E2' else i+1
            mass(j,f'v_{index}');v(f'w_{index}',page['calibration']['weights'][i],'1',dict(parameter='weights',index=i))
            nums.append(f'w_{index}*v_{index}');dens.append(f'w_{index}')
        expr='r = ('+'+'.join(nums)+')/('+'+'.join(dens)+')';label='Weighted mass';unit='mg'
    ast=numeric_parser(expr)
    result,dimension=evaluate(ast['args'][1],variables)
    with localcontext() as ctx:
        ctx.prec=40
        out=Decimal(result.numerator)/Decimal(result.denominator)
        rounded=out.quantize(Decimal('.00000001'))
    variables[ast['args'][0]['name']]=dict(valueDecimal=str(rounded),unit=unit)
    return dict(display=label+': '+expr, latex=latex(ast),ast=ast,
        variables=[dict(symbol=s,**vv) for s,vv in variables.items()], valueDecimal=str(rounded),
        absoluteTolerance=1e-8,constraints=['positive denominator','round half even to eight decimal places']+
            (['0 < v <= 1000 mg; u > 0 mg; n is a positive integer; r and g have unit mg'] if shape=='P' else [])+
            (['all weights strictly positive and dimensionless; selected masses in mg'] if shape in ('W','E2') else [])),bindings,shape


def text_runs(b,text,lines=None):
    typ=b['typography'];font=FONTS[typ['font_class']];size=typ['font_size_pt'];box=b['placement_container_pt']
    if lines is None:
        for n in range(b['budget']['lines'][0],b['budget']['lines'][1]+1):
            try:lines=split_lines(text,n,box[2]-box[0],font,size);break
            except ValueError:continue
        if lines is None:raise ValueError(('No legal breaks',b['id'],text))
    return [(line,box[0],box[1]+font.asc*size+i*typ['leading_pt'],typ['font_class'],size,0) for i,line in enumerate(lines)]


def make_cells(b,wp):
    t=b['table_shape'];mini=b['id'].endswith('discussion.mini-table');expanded=t['rows']==8
    if mini:
        data=[['Record','Loaded mass','Unit']]+[[r['cells'][0],r['cells'][1],'mg'] for r in wp['observations'][:3]]
    elif expanded:
        data=[['Record','Mass pair','','Response'],['Code','Load mg','Time s','Rate U']]+[r['cells'] for r in wp['observations']]
    else:data=[['Record','Load','Runtime','Rate']]+[r['cells'] for r in wp['observations']]
    typ=b['typography'];font=FONTS[typ['font_class']];size=typ['font_size_pt'];x0,y0,x1,y1=b['placement_container_pt'];rh=t['row_height_pt'];pad=t['cell_padding_pt']
    cells=[];runs=[];leaves=[];display=[]
    for row,values in enumerate(data):
        line=[];x=x0
        for col,val in enumerate(values):
            if expanded and row==0 and col==2:
                x+=t['column_widths_pt'][col];continue
            span=2 if expanded and row==0 and col==1 else 1
            physical=[x,y0+row*rh,x+sum(t['column_widths_pt'][col:col+span]),y0+(row+1)*rh]
            cellid=f'{b["id"]}.r{row}.c{col}'
            literal=val+(' | ' if not expanded and not mini and col<3 else '')
            baseline=[x+pad,y0+row*rh+font.asc*size]
            glyphs=font.run(cellid,literal,baseline,size)
            assert all(contains(physical,g['expectedInkPt']) for g in glyphs if g['expectedInkPt']),('Cell overflow',b['id'],row,col,literal)
            support=union([g['expectedInkPt'] for g in glyphs])
            leaves.append(dict(id=cellid,kind='cell',containerPt=physical,expectedSupportPt=support,glyphs=glyphs,
                primitivePaths=[],semanticSerialization=val,visibleGlyphSequence=literal,lineBreakOffsets=[],
                readingRank=b['reading_rank'],zOrder=b['z_order'],visible=True))
            cells.append(dict(row=row,column=col,rowSpan=1,columnSpan=span,displayText=val,value=val,
                unit='mg' if col==1 and row>=(2 if expanded else 1) else 's' if col==2 and row>=(2 if expanded else 1) else 'U' if col==3 and row>=(2 if expanded else 1) else '',
                bboxPt=physical,glyphIds=[g['id'] for g in glyphs],visible=True))
            runs.append((literal,*baseline,typ['font_class'],size,0));line.append(literal)
            x+=t['column_widths_pt'][col]
        display.append(' '.join(line))
    native=dict(data=[[v+(' | ' if not expanded and not mini and c<3 else '') for c,v in enumerate(row)] for row in data],
        widths=t['column_widths_pt'],rowHeight=rh,padding=pad,ruled=t['border']!='none',
        spans=[[0,1,0,2]] if expanded else [])
    return normalized('\n'.join(display)),runs,cells,leaves,native


def leaf(bid,kind,box,runs,paths,text,rank,z,visible=True):
    glyphs=[]
    for idx,(literal,x,y,font,size,rotation) in enumerate(runs):
        glyphs+=FONTS[font].run(f'{bid}.run{idx}',literal,[x,y],size,offset=len(glyphs),rotation=rotation)
    boxes=[g['expectedInkPt'] for g in glyphs if g['expectedInkPt']]
    for p in paths:
        x,y,xx,yy=p;boxes.append([min(x,xx)-.25,min(y,yy)-.25,max(x,xx)+.25,max(y,yy)+.25])
    return dict(id=bid,kind=kind,containerPt=box,expectedSupportPt=union(boxes) if boxes else box,
        glyphs=glyphs,primitivePaths=[json.dumps(p) for p in paths],semanticSerialization=text,
        visibleGlyphSequence=''.join(r[0] for r in runs),lineBreakOffsets=[],readingRank=rank,zOrder=z,visible=visible)


def choose_furniture(world,wp,b):
    subject=world['domain']['subject'].capitalize()
    options={
        'heading':[f'{subject} operating review',f'{subject} inspection record',f'{subject} condition assessment',f'{subject} technical findings',f'{subject} maintenance report'],
        'subheading':[f'Section {wp["number"]:02d} / Review cycle'],
        'matrix.title':['Measured transfer record'],
        'discussion.title':['Operator evidence and maintenance interpretation'],
        'footer':['Operations archive / reviewed for controlled release\nRetain with the current approved maintenance record.'],
        'chart.caption':['Observed inlet and return mass trajectories'],
    }
    if b['id'].startswith('overlay.row.'):
        i=int(b['id'].rsplit('.',1)[1]);options[b['id']]=[
            ['Valve condition / inspection pending','Service record / revision retained','Retained review / internal notes','Contact history / awaiting review','Release status / decision pending'][i]]
    if b['id']=='math.constraint':
        lo,hi=wp['policy']['endpoints']
        options[b['id']]=[f'Policy [{lo}, {hi}] mg; abs tolerance +/-0.2 mg',f'Reference [{lo}, {hi}] mg; abs tol +/-0.2 mg']
    for value in options.get(b['id'],[]):
        text=normalized(value)
        if not b['budget']['words'][0]<=len(words(text))<=b['budget']['words'][1]:continue
        if not b['budget']['characters'][0]<=len(text)<=b['budget']['characters'][1]:continue
        try:runs=text_runs(b,value)
        except (ValueError,AssertionError):continue
        return text,runs
    raise ValueError(('No furniture within simultaneous constraints',world['familyId'],wp['number'],b['id'],options.get(b['id'])))


def author_family(family,author,observer=None):
    world=make_world(family);d=layout(family);pages=[];plans=[];scenes=[];relations=[]
    for wp in world['pages']:
        pnum=wp['number'];pid=f'f{family["familyId"]:04d}.p{pnum:02d}';blocks=[];leaves=[];realized={};bindings=[]
        templates={b['id']:b for b in d['blocks']}
        body1,body2=author.pair(world,wp,templates['body.1'],templates['body.2'],d['body_words_total']['allowed'],family['worldSeed']+pnum*1234)
        for tb in d['blocks']:
            tid=tb['id'];bid=pid+'.'+tid;b=dict(tb,id=bid);runs=[];paths=[];cells=[];form=None;chart=None;children=[];native_table=None;text='';claim=None
            if 'table_shape' in b:
                text,runs,cells,children,native_table=make_cells(b,wp)
            elif tid in ['body.1','body.2','discussion.excerpt','discussion.commentary']:
                if tid in ('body.1','body.2'):text,lines,claim=body1 if tid=='body.1' else body2
                else:text,lines,claim=author.paragraph(world,wp,tb,tid,family['worldSeed']+pnum*1234+len(blocks))
                runs=text_runs(tb,text,lines)
            elif tid in ['math.rule','discussion.mini-math']:
                form,operand_bindings,shape=formula(family,wp,tid=='discussion.mini-math');text=form['display']
                runs,paths=math_runs(form,b['placement_container_pt'],8 if tid=='discussion.mini-math' else 9)
                bindings.append(dict(blockId=bid,formulaShape=shape,operands=operand_bindings))
            elif b['typography'] and tid!='chart': text,runs=choose_furniture(world,wp,tb)
            elif tid=='chart':
                # Full plot resolution is independent of producer choice.
                text,runs,paths,chart,children=resolve_chart(b,wp,pid)
            own=leaf(bid,'formula' if form else 'text' if runs else 'frame',b['placement_container_pt'],runs,paths,text,b['reading_rank'],b['z_order'],b['visible'])
            if children:
                own['expectedSupportPt']=union(c['expectedSupportPt'] for c in children)
                own['glyphs']=[g for c in children for g in c['glyphs']]
            assert contains(b['placement_container_pt'],own['expectedSupportPt']),('Expected ink exceeds fixed envelope',family['familyId'],pnum,tid,own['expectedSupportPt'],b['placement_container_pt'])
            for child in children:
                assert contains(child['containerPt'],child['expectedSupportPt']),('Child overflow',child['id'])
            if runs:
                assert b['budget']['words'][0]<=len(words(text))<=b['budget']['words'][1],('words',tid,len(words(text)),text)
                assert b['budget']['characters'][0]<=len(normalized(text))<=b['budget']['characters'][1],('chars',tid,len(normalized(text)),text)
            if children:leaves+=children
            else:leaves.append(own)
            glyphs=own['glyphs']
            fonts=[]
            for kind,size in sorted({(r[3],r[4]) for r in runs}):
                fonts.append(dict(family=FONTS[kind].family,fileHash=FONTS[kind].hash,sizePt=size,
                    leadingPt=b['typography']['leading_pt'] if b['typography'] else size*1.2,weight=400,embedded=True,subset=True))
            auth=dict(id=bid,templateId=tid,role=b['role'],visible=b['visible'],bboxPt=own['expectedSupportPt'],
                bboxNormalized=[v/(612 if i%2==0 else 792) for i,v in enumerate(own['expectedSupportPt'])],
                containerPt=b['placement_container_pt'],zOrder=b['z_order'],readingRank=b['reading_rank'],displayText=text,
                glyphs=[dict(id=g['id'],text=g['text'],bboxPt=g['expectedInkPt'] or [*g['baselinePt'],*g['baselinePt']],visible=b['visible'],
                    blockId=bid,logicalOffset=g['logicalOffset'],displayOrdinal=i) for i,g in enumerate(glyphs)],
                fonts=fonts,cells=cells,formula=form,chart=chart,assetHash=None,
                semanticClass='decoy' if tid in ('overlay.row.2','overlay.row.3') else 'quoted' if tid=='discussion.excerpt' else 'ordinary' if runs else 'decoration')
            blocks.append(auth)
            if observer: observer(pid,tid,auth)
            realized[bid]=dict(runs=runs,paths=paths,table=native_table,children=children)
            if claim:bindings.append(dict(blockId=bid,literal=text,**claim))
        ro=[pid+'.'+tid for tid in d['reading_order']]
        components,order=paint_order(blocks,family['familyId'],pnum,False)
        markdown='\n\n'.join(next(b['displayText'] for b in blocks if b['id']==bid) for bid in ro)
        section_ids=[bid for bid in ro if next(b for b in blocks if b['id']==bid)['role'] in ('heading','subheading','technical-caption','inset-heading')]
        paragraph_ids=[bid for bid in ro if next(b for b in blocks if b['id']==bid)['role'] in ('body','quoted-excerpt','commentary','footer')]
        strings={b['id']:b['displayText'] for b in blocks}
        page=dict(id=pid,number=pnum,sizePt=[612,792],layoutContractId=d['own_spec_id'],blocks=blocks,readingOrder=ro,
            expectedMarkdown=markdown,sections=[strings[bid] for bid in section_ids],paragraphs=[strings[bid] for bid in paragraph_ids],
            blockIdsForSections=section_ids,blockIdsForParagraphs=paragraph_ids,
            visibleGlyphCount=sum(g['visible'] for b in blocks for g in b['glyphs']))
        pages.append(page)
        plans.append(freeze(dict(schema='enriched-support-plan@5',classLayout=d['own_spec_id'],pageId=pid,
            worldHash=world['worldHash'],contractHash=digest(d),fontMetricEngine='fontTools '+__import__('fontTools').version,
            producerVersion='producer-independent frozen geometry',leaves=leaves,canonicalReadingOrder=ro,
            paintComponents=components,paintOrder=order),'planHash'))
        scenes.append(dict(pageId=pid,number=pnum,blocks=blocks,resolved=realized,paintOrder=order))
        relations.append(dict(pageId=pid,claims=bindings))
    auth=freeze(dict(schema='mixed-pdf-authoring@4',familyId=family['familyId'],split='train',classId=family['classId'],layoutId=family['layoutId'],
        specHash=INPUT_HASHES['spec-a6.json'],worldHash=world['worldHash'],producerPath=family['producerPath'],seed=family['worldSeed'],pages=pages),'authoringHash')
    return world,auth,plans,scenes,relations


def resolve_chart(b,wp,pid):
    recipe=b['chart_shape']['placement_recipe'];font=FONTS['sans'];size=8;box=b['placement_container_pt'];runs=[];paths=[];children=[]
    def label(suffix,text,x,y,align='left',rot=0):
        width=font.width(text,size)
        if align=='center':x-=width/2
        if align=='right':x-=width
        run=(text,x,y,'sans',size,rot)
        runs.append(run)
        children.append(leaf(b['id']+'.'+suffix,'chart-label',box,[run],[],text,b['reading_rank'],b['z_order']))
    title='Mass transfer during inspection'
    label('title',title,*recipe['title_baseline_pt'],'center')
    label('x-axis','Elapsed time (s)',*recipe['x_axis_baseline_pt'],'center')
    center=recipe['y_axis_center_pt'];ylabel='Loaded mass (mg)'
    label('y-axis',ylabel,center[0],center[1]+font.width(ylabel,size)/2,'left',270)
    px0,py0,px1,py1=recipe['plot_rect_pt'];series=wp['chart'];ys=[Decimal(y) for s in series for y in s['y']]
    ymin=int(min(ys))-1;ymax=math.ceil(max(ys))+1
    ticks=[];legends=[]
    for i in range(8):
        x=px0+i*(px1-px0)/7
        label(f'xtick{i}',str(i+1),x,recipe['x_tick_baseline_y_pt'],'center')
        paths.append([x,py1,x,py1+3])
        ticks.append(dict(axis='x',valueDecimal=str(i+1),displayText=str(i+1),bboxPt=children[-1]['expectedSupportPt']))
    for i in range(5):
        value=Decimal(ymin)+(Decimal(ymax-ymin)*i/4);y=py1-float((value-ymin)/(ymax-ymin))*(py1-py0)
        literal=str(value.quantize(Decimal('.1')))
        label(f'ytick{i}',literal,recipe['y_tick_right_x_pt'],y+(font.asc+font.desc)*size/2,'right')
        paths.append([px0-3,y,px0,y])
        ticks.append(dict(axis='y',valueDecimal=str(value),displayText=literal,bboxPt=children[-1]['expectedSupportPt']))
    paths += [[px0,py0,px0,py1],[px0,py1,px1,py1]]
    for i,s in enumerate(series):
        label(f'legend{i}',s['name'],recipe['legend_text_lefts_pt'][i],recipe['legend_baseline_y_pt'])
        legends.append(dict(displayText=s['name'],seriesIndex=i,bboxPt=children[-1]['expectedSupportPt']))
        paths.append(recipe['legend_swatches_pt'][i])
        xy=[(px0+j*(px1-px0)/7,py1-float((Decimal(y)-ymin)/(ymax-ymin))*(py1-py0)) for j,y in enumerate(s['y'])]
        paths += [[*a,*z] for a,z in zip(xy,xy[1:])]
    text=normalized(' '.join(r[0] for r in runs))
    chart=dict(kind='line',data=[dict(name=s['name'],xDecimals=s['x'],yDecimals=s['y'],unitX=s['unitX'],unitY=s['unitY']) for s in series],
        title=title,axisTitles=['Elapsed time (s)',ylabel],ticks=ticks,legend=legends,
        textGlyphIds=[g['id'] for c in children for g in c['glyphs']],captionBlockId=pid+'.chart.caption')
    return text,runs,paths,chart,children
