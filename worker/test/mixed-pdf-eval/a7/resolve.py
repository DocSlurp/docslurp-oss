"""Resolve exact source literals and pinned-outline support BEFORE native export."""
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import shutil
import sys
import unicodedata

from author import PAGES

HANDOFF = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a7-clean-r2')
OUT = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round1')
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(HANDOFF / 'generic'))
from support import FONTS, normalized, words, split_lines, union, contains, paint_components

SPEC = json.loads((HANDOFF / 'spec-a7.json').read_text())
COLOR = [.08, .10, .12]

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()

def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()

def write(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    data=value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False, indent=2).encode() + b'\n'
    if path.exists():
        assert path.read_bytes()==data, f'No overwrite: {path}'
        return
    path.write_bytes(data)

def token_array(text):
    text = unicodedata.normalize('NFC', text).casefold()
    tokens = []; current = ''
    for char in text:
        if unicodedata.category(char).startswith('L'): current += char
        elif current: tokens.append(current); current = ''
    if current: tokens.append(current)
    return tokens

def dimension(unit):
    if unit == '1': return {}
    if '/' not in unit: return {unit:1}
    numerator, denominator = unit.split('/')
    result = dimension(numerator)
    for name, power in dimension(denominator).items(): result[name] = result.get(name,0)-power
    return {name:power for name,power in result.items() if power}

def evaluate(ast, variables):
    op = ast['op']
    if op == 'symbol':
        v = variables[ast['name']]
        assert re.fullmatch(r'-?(0|[1-9][0-9]*)(\.[0-9]+)?', v['valueDecimal'])
        return Fraction(Decimal(v['valueDecimal'])), dimension(v['unit'])
    values = [evaluate(a, variables) for a in ast['args']]
    if op in ['add','subtract']:
        assert all(d == values[0][1] for v,d in values)
        return (sum(v for v,d in values) if op=='add' else values[0][0]-values[1][0]), values[0][1]
    if op in ['multiply','divide']:
        value = Fraction(1); dims = Counter()
        for i,(v,d) in enumerate(values):
            sign = -1 if op == 'divide' and i else 1
            assert sign == 1 or v != 0
            value = value * v if sign == 1 else value / v
            for name,power in d.items(): dims[name] += sign*power
        return value,{name:power for name,power in dims.items() if power}
    raise ValueError(op)

def calibration():
    """Read only constructed mechanism evidence, never candidate measurements."""
    import pymupdf
    control = OUT/'mechanism-setup/control-05.pdf'
    result = {}
    parameters = [('sans',10,14.7705),('sans',13,19.2017),('mono',9,11),('mono',10,11.6407),
                  ('sans',8,10),('sans',9,13.2935),('mono',9,12),('mono',9,10.4766)]
    with pymupdf.open(control) as doc:
        traces = doc[0].get_texttrace()
        for i,(font,size,leading) in enumerate(parameters):
            rows = [t for t in traces if ''.join(chr(c[0]) for c in t['chars']) == 'Agx09|+/ K mV'
                    and 40+i*45 <= t['chars'][0][2][1] < 40+i*45+44]
            rows.sort(key=lambda t:t['chars'][0][2][1])
            assert len(rows)==2 and rows[0]['size']==size
            assert ('Mono' in rows[0]['font']) == (font=='mono')
            x,y = rows[0]['chars'][0][2]
            result[f'{font}:{size}:{leading}'] = {'xOffsetPt':x-39, 'baselineOffsetPt':y-(40+i*45),
                                                   'actualLeadingPt':rows[1]['chars'][0][2][1]-y}
    return {'source':str(control), 'sha256':digest(control.read_bytes()), 'textFrames':result,
            'tables':{'9:False':{'xOffsetPt':.1,'baselineOffsetPt':8.4},
                      '10:True':{'xOffsetPt':.1,'baselineOffsetPt':9.65},
                      '10:False':{'xOffsetPt':.1,'baselineOffsetPt':9.3}},
            'rotatedSans8':{'controlFramePt':[420,600,480,610], 'actualFirstBaselinePt':[453.3,635.0],
                            'actualDirection':[0,-1], 'nativeFrameWidthPt':60,'nativeFrameHeightPt':10},
            'policy':'Fixed per font/size/leading or table style from constructed controls; no candidate-derived target fitting.'}

CAL = calibration()

def text_object(id, text, x, baseline, width, font, size, leading, z=20, spans=None, rotation=0):
    if rotation:
        # The 60x10 independent TextShape control rotates about its center.
        frame = [x-33.3, baseline-35, x+26.7, baseline-25]
    else:
        c = CAL['textFrames'][f'{font}:{size}:{leading}']
        top = baseline - c['baselineOffsetPt']
        frame = [x-c['xOffsetPt'], top, x-c['xOffsetPt']+width, top+leading*len(text.split('\n'))]
    return dict(id=id,kind='text',text=text,font=font,sizePt=size,leadingPt=leading,color=COLOR,
                baselinePt=[x,baseline],framePt=frame,spans=spans or [],rotation=rotation,z=z)

def leaf(id, kind, box, glyphs, serial, rank, z, paths=None, visible_sequence=None, offsets=None):
    paths = paths or []
    boxes = [g['expectedInkPt'] for g in glyphs if g['expectedInkPt']]
    if paths:
        for path in paths:
            p = json.loads(path)
            points = p['pointsPt']; half = p.get('widthPt',0)/2
            boxes.append([min(v[0] for v in points)-half,min(v[1] for v in points)-half,
                          max(v[0] for v in points)+half,max(v[1] for v in points)+half])
    support = union(boxes) if boxes else box
    return dict(id=id,kind=kind,containerPt=box,expectedSupportPt=support,glyphs=glyphs,
                primitivePaths=paths,semanticSerialization=serial,
                visibleGlyphSequence=visible_sequence if visible_sequence is not None else ''.join(g['text'] for g in glyphs),
                lineBreakOffsets=offsets or [],readingRank=rank,zOrder=z,visible=True)

def add_text(plan, leaves, id, lines, box, ty, rank, kind='text', rotation=0, explicit_baseline=None, width=None):
    font = FONTS[ty['font_class']]; size=ty['font_size_pt']; leading=ty['leading_pt']
    x,baseline = explicit_baseline or [box[0],box[1]+font.asc*size]
    glyphs=[]; offset=0; offsets=[]
    for i,line in enumerate(lines):
        glyphs.extend(font.run(id,line,[x,baseline+i*leading],size,offset=offset,rotation=rotation))
        offset += len(line); offsets.append(offset)
    plan['objects'].append(text_object(id,'\n'.join(lines),x,baseline,width or box[2]-box[0],ty['font_class'],size,leading,
                                       rotation=rotation))
    item=leaf(id,kind,box,glyphs,' '.join(lines),rank,20,offsets=offsets[:-1]);leaves.append(item)
    return item

def formula_plan(page, plan, leaves, block, prefix):
    formula=page['formula']; box=block['placement_container_pt'];font=FONTS['mono']; size=9
    x=box[0];b=box[1]+font.asc*size; segments=[];paths=[]
    if formula['recipe'] in ['Q','E2-three-term-W']:
        label=formula['display'].split(':',1)[0]+': '+formula['ast']['args'][0]['name']+' = '
        segments.append((label,x,b+6,[]))
        if formula['recipe']=='Q':
            top=[{'text':'V','dyPt':0}];bottom=[{'text':'t','dyPt':0}]
        else:
            top=[];bottom=[]
            for i in range(1,4):
                if i>1:top.append({'text':'+','dyPt':0});bottom.append({'text':'+','dyPt':0})
                top.extend([{'text':'n','dyPt':0},{'text':str(i),'dyPt':2},{'text':'*T','dyPt':0},{'text':str(i),'dyPt':2}])
                bottom.extend([{'text':'n','dyPt':0},{'text':str(i),'dyPt':2}])
        tx=''.join(s['text'] for s in top);bx=''.join(s['text'] for s in bottom)
        w=max(font.width(tx,size),font.width(bx,size))+font.width(' ',size)
        fx=x+font.width(label,size)
        segments.extend([(tx,fx+(w-font.width(tx,size))/2,b,top),(bx,fx+(w-font.width(bx,size))/2,b+12,bottom)])
        paths.append(dict(id=prefix+'math.rule.bar',kind='path',pointsPt=[[fx,b+3.2],[fx+w,b+3.2]],color=COLOR,widthPt=.45,z=20))
    else:
        assert formula['recipe']=='A'
        segments.append(('Bridge: T = g*V+h',x,b,[]))
    glyphs=[]; logical=0
    for i,(text,xx,bb,spans) in enumerate(segments):
        id=prefix+f'math.rule.line{i}'
        plan['objects'].append(text_object(id,text,xx,bb,max(font.width(text,size)+.2,5.6),'mono',9,12,spans=spans))
        if not spans:spans=[{'text':text,'dyPt':0}]
        for span in spans:
            glyphs.extend(font.run(prefix+'math.rule',span['text'],[xx,bb+span['dyPt']],size,offset=logical))
            xx+=font.width(span['text'],size);logical+=len(span['text'])
    plan['objects'].extend(paths)
    leaves.append(leaf(prefix+'math.rule','formula',box,glyphs,formula['display'],block['reading_rank'],20,
                       paths=[json.dumps(p,sort_keys=True) for p in paths]))

def chart_plan(page,plan,leaves,block,prefix):
    chart=page['chart'];world=page['world'];recipe=block['chart_shape']['placement_recipe'];box=block['placement_container_pt']
    font=FONTS['sans'];size=8;ty=block['typography'];children=[]
    def label(name,text,x,y,align='left',rotation=0):
        width=font.width(text,size)
        if align=='center':x-=width/2
        if align=='right':x-=width
        # Rotated label starts below the declared center then runs upward.
        if rotation:y+=width/2
        item=add_text(plan,children,prefix+'chart.'+name,[text],box,ty,block['reading_rank'],'chart-label',rotation,
                      explicit_baseline=[x,y],width=max(width+.2,8))
        return item
    label('title',chart['title'],*recipe['title_baseline_pt'],'center')
    label('xaxis',chart['xAxis'],*recipe['x_axis_baseline_pt'],'center')
    label('yaxis',chart['yAxis'],*recipe['y_axis_center_pt'],rotation=270)
    left,top,right,bottom=recipe['plot_rect_pt'];low,high=map(Decimal,chart['yDomain'])
    def xy(x,y):return [left+(right-left)*(float(Decimal(x))-1)/7,bottom-float((Decimal(y)-low)/(high-low))*(bottom-top)]
    for i,t in enumerate(chart['xTicks']):label(f'xtick{i}',t,xy(t,'0')[0],recipe['x_tick_baseline_y_pt'],'center')
    for i,t in enumerate(chart['yTicks']):
        label(f'ytick{i}',t,recipe['y_tick_right_x_pt'],xy('1',t)[1]+(font.asc+font.desc)*size/2,'right')
    for i,t in enumerate(chart['legend']):label(f'legend{i}',t,recipe['legend_text_lefts_pt'][i],recipe['legend_baseline_y_pt'])
    paths=[]
    def path(name,points,color,width):
        o=dict(id=prefix+'chart.'+name,kind='path',pointsPt=points,color=color,widthPt=width,z=18)
        paths.append(o);plan['objects'].append(o)
    # Axis rectangle is an actual vector primitive, separate from text support.
    path('axes',[[left,top],[left,bottom],[right,bottom],[right,top],[left,top]],[.42,.48,.52],.5)
    for i,t in enumerate(chart['xTicks']):
        xx=xy(t,'0')[0];path(f'xtickmark{i}',[[xx,bottom],[xx,bottom+3]],[.42,.48,.52],.5)
    for i,t in enumerate(chart['yTicks']):
        yy=xy('1',t)[1];path(f'ytickmark{i}',[[left-3,yy],[left,yy]],[.42,.48,.52],.5)
    for i,key in enumerate(chart['seriesKeys']):
        points=[xy(x,y) for x,y in zip(world['xReadings'],world[key])]
        path(f'series{i}',points,chart['seriesColors'][i],.9)
        sw=recipe['legend_swatches_pt'][i];path(f'swatch{i}',[sw[:2],sw[2:]],chart['seriesColors'][i],.9)
    leaves.extend(children)
    allglyphs=[g for l in children for g in l['glyphs']]
    # Parent uses the union of true label/primitive support; no full-frame substitute.
    leaves.append(leaf(prefix+'chart','frame',box,allglyphs,' '.join(l['semanticSerialization'] for l in children),
                       block['reading_rank'],18,[json.dumps(p,sort_keys=True) for p in paths]))

def table_plan(page,plan,leaves,block,prefix):
    shape=block['table_shape'];box=block['placement_container_pt'];ty=block['typography'];font=FONTS['mono'];size=ty['font_size_pt']
    data=page['table'];e2=page['classId']=='E2';glyphs=[];cells=[];display=[];misses=[]
    for row, values in enumerate(data):
        xx=box[0]; texts=[]
        for col,value in enumerate(values):
            if e2 and row==0 and col==2:xx+=shape['column_widths_pt'][col];continue
            rg=shape['header_character_ranges'][col] if row in shape['header_rows'] else shape['data_character_ranges'][col]
            if not rg[0]<=len(value)<=rg[1]:misses.append({'cell':[row,col],'range':rg,'characters':len(value)})
            serial=value;displayvalue=value+(' | ' if not e2 and col<3 else '')
            cellbox=[xx,box[1]+row*shape['row_height_pt'],xx+shape['column_widths_pt'][col]*(2 if e2 and row==0 and col==1 else 1),box[1]+(row+1)*shape['row_height_pt']]
            id=prefix+f'matrix.table.r{row}c{col}'
            gg=font.run(id,displayvalue,[xx+shape['cell_padding_pt'],cellbox[1]+font.asc*size],size)
            cellleaf=leaf(id,'cell',cellbox,gg,serial,block['reading_rank'],20)
            leaves.append(cellleaf);cells.append({'id':id,'row':row,'column':col,'rowSpan':1,'columnSpan':2 if e2 and row==0 and col==1 else 1,
                                                'literal':value,'displayLiteral':displayvalue,'physicalCellPt':cellbox})
            glyphs.extend(gg);xx+=shape['column_widths_pt'][col];texts.append(displayvalue)
        display.append(texts)
    assert not misses,misses
    c=CAL['tables'][f'{size}:{e2}']
    native_top=box[1]+font.asc*size-c['baselineOffsetPt']
    # Fixed calibration changes native frame placement, never the frozen expected cells.
    native_data=[[v+(' | ' if col<3 and not e2 else '') for col,v in enumerate(r)] for r in data]
    plan['objects'].append(dict(id=prefix+'matrix.table',kind='table',data=native_data,span=e2,rules=e2,paddingPt=shape['cell_padding_pt'],
                                columnWidthsPt=shape['column_widths_pt'],rowHeightPt=shape['row_height_pt'],sizePt=size,
                                leadingPt=ty['leading_pt'],color=COLOR,z=20,
                                framePt=[box[0]-.1,native_top,box[0]-.1+sum(shape['column_widths_pt']),native_top+shape['row_height_pt']*len(data)+2]))
    serial='\n'.join(' | '.join(r) for r in data) if not e2 else '\n'.join(' '.join(v for v in r if v) for r in data)
    leaves.append(leaf(prefix+'matrix.table','frame',box,glyphs,normalized(serial),block['reading_rank'],20))
    return cells,serial

def helper_validation():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    checks=[]
    for kind,font in FONTS.items():
        pdfmetrics.registerFont(TTFont('Control'+kind,str(font.path)))
        for size in [8,9,10,13]:
            text='Agx09|+/ K mV'
            assert abs(font.width(text,size)-pdfmetrics.stringWidth(text,'Control'+kind,size))<1e-10
            glyphs=font.run('control',text,[39,60],size)
            assert len(glyphs)==len(text) and glyphs[0]['fontHash']==digest(font.path.read_bytes())
            checks.append({'font':kind,'size':size,'widthAgreement':True,'cmapAndOutlineResolved':True})
    assert normalized(' A\tB\nC ')=='A B C'
    assert words('a | +/- 3')==['a','3']
    f=FONTS['sans'];ls=split_lines('A short control sentence uses two clear lines.',2,130,f,10)
    assert ' '.join(ls)=='A short control sentence uses two clear lines.' and all(f.width(l,10)<=130 for l in ls)
    assert union([[1,2,3,4],[0,3,8,7]])==[0,2,8,7] and contains([0,0,10,10],[1,2,3,4])
    assert evaluate({'op':'divide','args':[{'op':'symbol','name':'a'},{'op':'symbol','name':'b'}]},
                    {'a':{'valueDecimal':'0.1','unit':'L'},'b':{'valueDecimal':'0.3','unit':'min'}})==(Fraction(1,3),{'L':1,'min':-1})
    assert paint_components([{'id':'a','containerPt':[0,0,10,10]},{'id':'b','containerPt':[13,0,20,10]},
                             {'id':'c','containerPt':[30,0,40,10]}])==[['a','b'],['c']]
    return {'scope':'mechanisms used by this preview only; not an acceptance certificate','fontControls':checks,
            'normalizationWordsUnionContainsLineSolverComponents':True,'exactDecimalNoFloatRoundtrip':True}

def novelty(records):
    flags=[];comparisons=[]
    for a,b in itertools.combinations(records,2):
        aa=a['tokens'];bb=b['tokens'];shared=[]
        for i in range(len(aa)-7):
            for j in range(len(bb)-7):
                if aa[i:i+8]!=bb[j:j+8]:continue
                if i and j and aa[i-1]==bb[j-1]:continue
                n=8
                while i+n<len(aa) and j+n<len(bb) and aa[i+n]==bb[j+n]:n+=1
                shared.append({'aOffset':i,'bOffset':j,'tokens':aa[i:i+n]})
        ag={tuple(aa[i:i+5]) for i in range(len(aa)-4)};bg={tuple(bb[i:i+5]) for i in range(len(bb)-4)}
        score=len(ag&bg)/len(ag|bg) if ag|bg else 0
        substantive=a['substantive'] and b['substantive']
        comparison={'a':a['id'],'b':b['id'],'fivegramJaccard':score,'emptyUnion':not bool(ag|bg),'substantivePair':substantive}
        comparisons.append(comparison)
        if shared or substantive and score>.35:
            flags.append({**comparison,'sharedEightTokenRuns':shared,'scope':'cross-family' if a['familyId']!=b['familyId'] else 'within-family',
                          'proposedClassification':'independent review required','independentAdjudication':'pending; no automatic waiver'})
        assert not (substantive and aa==bb),'Exact substantive duplication'
    return {'algorithm':'NFC-casefold-maximal-Unicode-L-runs@1','blocks':records,'comparisons':comparisons,'reviewFlags':flags,
            'semanticTemplateEditorialReview':'requires actual editorial review; lexical statistics do not establish originality',
            'sourceLeakage':'not evaluated here; source-blind builder does not access source or protected-name list'}

def main():
    assert (OUT/'runtime-source-receipt.json').exists()
    assert not (OUT/'FREEZE.json').exists()
    write(OUT/'mechanism-validation.json',helper_validation())
    write(OUT/'writer-calibration.json',CAL)
    metrics=[];records=[];files=[];allmisses=[]
    for page in PAGES:
        fid=page['familyId'];prefix=f'f{fid:04d}.p01.';stem=f'f{fid:04d}-{page["classId"]}-{page["layoutId"]}-p01'
        layout=SPEC['enriched_derivatives'][page['classId']]['layouts'][page['layoutId']]
        recipe=SPEC['formula_shape_library'][(fid+page['pageNumber']-1)%5]['id']
        assert page['classId']=='E2' or page['formula']['recipe']==recipe
        world={'familyId':fid,**page['world']};worldhash=digest(world)
        write(OUT/(stem+'.world.json'),world)
        plan={'stem':stem+'-writer-original','title':page['title'],'author':{'E1':'Process Engineering','E2':'Metrology','E3':'Instrumentation'}[page['classId']],
              'familyId':fid,'pageNumber':1,'classLayout':page['classId']+'-'+page['layoutId'],'objects':[]}
        leaves=[];bodywords=0;cells=[]
        for block in layout['blocks']:
            name=block['id'];box=block['placement_container_pt'];ty=block['typography'];id=prefix+name
            if name=='matrix.table':cells,serial=table_plan(page,plan,leaves,block,prefix);nlines=len(page['table'])
            elif name=='math.rule':formula_plan(page,plan,leaves,block,prefix);serial=page['formula']['display'];nlines=2 if page['classId'] in ['E1','E2'] else 1
            elif name=='chart':
                chart_plan(page,plan,leaves,block,prefix)
                serial=' '.join(l['semanticSerialization'] for l in leaves if l['kind']=='chart-label');nlines=1
            elif name in page['literals']:
                serial=page['literals'][name];font=FONTS[ty['font_class']];lines=None
                for nlines in range(block['budget']['lines'][0],block['budget']['lines'][1]+1):
                    try:lines=split_lines(serial,nlines,box[2]-box[0],font,ty['font_size_pt']);break
                    except ValueError:pass
                assert lines is not None,(id,'No legal line breaks')
                add_text(plan,leaves,id,lines,box,ty,block['reading_rank'])
            elif name=='discussion.frame':
                plan['objects'].append(dict(id=id,kind='rect',rectPt=box,fill=[.93,.95,.97],z=10))
                leaves.append(leaf(id,'frame',box,[],'',None,10))
                continue
            elif name=='side.image':
                # Text-free sensor-rack sketch: native vectors, matching this logger page.
                plan['objects'].append(dict(id=id,kind='rect',rectPt=box,fill=[.89,.93,.95],z=15))
                paths=[[[445,547],[535,547],[535,610],[445,610],[445,547]],[[465,547],[465,532],[515,532],[515,547]],
                       [[456,559],[456,596]],[[475,559],[475,596]],[[494,559],[494,596]],[[513,559],[513,596]],
                       [[435,620],[545,620]]]
                for i,p in enumerate(paths):plan['objects'].append(dict(id=id+f'.rack{i}',kind='path',pointsPt=p,color=[.30,.43,.50],widthPt=1,z=16))
                leaves.append(leaf(id,'frame',box,[],'',None,15));continue
            elif name=='footer.ornament':
                plan['objects'].append(dict(id=id,kind='rect',rectPt=box,fill=[.82,.88,.92],z=5))
                leaves.append(leaf(id,'frame',box,[],'',None,5));continue
            else:raise ValueError(name)
            counts={'words':len(words(serial)),'characters':len(normalized(serial)),'lines':nlines}
            misses=[{'metric':k,'actual':v,'range':block['budget'][k]} for k,v in counts.items() if not block['budget'][k][0]<=v<=block['budget'][k][1]]
            metrics.append({'blockId':id,**counts,'misses':misses})
            allmisses.extend(misses)
            if name in ['body.1','body.2']:bodywords+=counts['words']
            if name not in ['heading','subheading','footer']:
                records.append({'id':id,'familyId':fid,'text':normalized(serial),'tokens':token_array(serial),
                                'substantive':name in ['body.1','body.2','discussion.excerpt','discussion.commentary']})
        assert layout['body_words_total']['allowed'][0]<=bodywords<=layout['body_words_total']['allowed'][1]
        for l in leaves:
            if not contains(l['containerPt'],l['expectedSupportPt']):allmisses.append({'id':l['id'],'kind':'frozen support outside container','support':l['expectedSupportPt'],'container':l['containerPt']})
        value,dims=evaluate(page['formula']['ast']['args'][1],page['formula']['variables'])
        assert value==Fraction(page['formula']['resultExact'])
        assert dims==dimension(page['formula']['variables'][page['formula']['ast']['args'][0]['name']]['unit'])
        # Parent supports contain child outlines, with no duplicate logical glyph population.
        components=paint_components([{'id':prefix+b['id'],'containerPt':b['placement_container_pt']} for b in layout['blocks']])
        support={'schema':'enriched-support-plan@5','classLayout':plan['classLayout'],'pageId':prefix[:-1],
                 'worldHash':worldhash,'contractHash':digest((HANDOFF/'spec-a7.json').read_bytes()),
                 'fontMetricEngine':'fontTools 4.67.0 cmap+hmtx+BoundsPen; no candidate readback',
                 'producerVersion':'ReportLab 5.1.0 / LibreOffice 26.8.1.1; preview only',
                 'leaves':leaves,'canonicalReadingOrder':[prefix+x for x in layout['reading_order']],
                 'paintComponents':components,'paintOrder':[o['id'] for o in sorted(plan['objects'],key=lambda o:(o.get('z',20),o['id']))]}
        support['planHash']=digest(support)
        import jsonschema
        jsonschema.Draft202012Validator(SPEC['enriched_resolution_plan_schema']).validate(support)
        write(OUT/(stem+'.support.json'),support)
        write(OUT/(stem+'.drawing-plan.json'),plan)
        interval=world['referenceInterval'];tolerance=world['measurementTolerance']
        constraint_ast={'op':'and','args':[{'op':'interval','args':[{'op':'constant','valueDecimal':interval['lower']},
                                                                 {'op':'constant','valueDecimal':interval['upper']}]},
                                            {'op':'tolerance','args':[{'op':'constant','valueDecimal':tolerance['value']}]}]}
        authoring={**page,'pageId':prefix[:-1],'worldHash':worldhash,'cells':cells,
                   'constraintAst':constraint_ast,'constraintBindings':{'intervalRole':'reference_interval','quantity':interval['quantity'],
                       'unit':interval['unit'],'inclusive':True,'toleranceUnit':tolerance['unit'],'tolerancePurpose':tolerance['purpose'],
                       'literal':page['literals']['math.constraint']},
                   'scope':'partial diagnostic page, not a ten-page authoring record or conformance claim',
                   'formulaEvaluation':{'valueExact':str(value),'dimension':dims}}
        write(OUT/(stem+'.exact-authoring.json'),authoring)
        files.extend([stem+s for s in ['.world.json','.support.json','.drawing-plan.json','.exact-authoring.json']])
    write(OUT/'literal-metric-validation.json',{'blocks':metrics,'misses':allmisses})
    write(OUT/'intra-candidate-novelty.json',novelty(records))
    assert not allmisses,allmisses
    # Freeze code and literal/geometry inputs before invoking either candidate producer.
    code=OUT/'frozen-code';code.mkdir()
    for path in sorted(ROOT.glob('*.py')):
        shutil.copyfile(path,code/path.name)
        files.append('frozen-code/'+path.name)
    files.extend(['runtime-source-receipt.json','outlines.json','outlines.md','technical-reuse-declaration.json',
                  'writer-calibration.json','literal-metric-validation.json','mechanism-validation.json','intra-candidate-novelty.json'])
    write(OUT/'FREEZE.json',{'attempt':7,'formalRound':1,'frozenAtUtc':datetime.now(timezone.utc).isoformat(),
                            'scope':'three page-one previews, both original native producers; no transformations or bulk export',
                            'files':{n:digest((OUT/n).read_bytes()) for n in sorted(files)},
                            'revisionPolicy':'Any changed failed preview consumes the next formal round; preserve this directory unchanged.'})
    print('FROZEN',str(OUT/'FREEZE.json'))

if __name__=='__main__':main()
