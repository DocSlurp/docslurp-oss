"""Independent native-object, ink, render, and exact semantic verification."""
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
import math
import re
import fitz
import numpy as np
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from support import *
from maths import parse,evaluate,dimension


def semantic_checks(spec,family,world,authoring,plans,resolved):
    misses=[];fingerprints={};eight={};ngrams=[]
    def require(condition,message,identity):
        if not condition:misses.append(dict(kind=message,id=identity))
    for record,key in [(world,'worldHash'),(authoring,'authoringHash')]+[(p,'planHash') for p in plans]:
        require(record.get(key)==digest({k:v for k,v in record.items() if k!=key}),'immutable hash',key)
    require(authoring['worldHash']==world['worldHash'],'authoring world binding',str(family['familyId']))
    for facts,page,plan,r in zip(world['pages'],authoring['pages'],plans,resolved['pages']):
        pid=page['id'];lookup={b['templateId']:b for b in page['blocks']}
        require(plan['worldHash']==world['worldHash'],'world binding',pid)
        require(plan['canonicalReadingOrder']==page['readingOrder'],'reading order',pid)
        require(len(plan['paintOrder'])==len(page['blocks']) and set(plan['paintOrder'])=={b['id'] for b in page['blocks']},'paint membership',pid)
        require(page['sections']==page['paragraphs']==[next(b['displayText'] for b in page['blocks'] if b['id']==bid) for bid in page['readingOrder']],'gold projection',pid)
        require(page['expectedMarkdown']=='\n\n'.join(page['sections']),'gold Markdown',pid)
        pg=[g for leaf in plan['leaves'] for g in leaf['glyphs']]
        ag=[g for b in page['blocks'] for g in b['glyphs']]
        require(len(pg)==len({g['id'] for g in pg}) and {g['id'] for g in pg}=={g['id'] for g in ag},'one-to-one glyph membership',pid)
        for b in page['blocks']:
            if b['role'] in ['body','quoted-excerpt','commentary']:
                tokens=re.findall('[a-z]+',b['displayText'].lower());fp=' '.join(tokens)
                require(fp not in fingerprints,'duplicate prose',b['id']);fingerprints[fp]=b['id']
                for i in range(len(tokens)-7):
                    run=tuple(tokens[i:i+8]);require(run not in eight or eight[run]==b['id'],'shared eight-token run',b['id']);eight[run]=b['id']
                gram={tuple(tokens[i:i+5]) for i in range(len(tokens)-4)}
                for other,ss in ngrams:
                    require(len(gram&ss)/max(1,len(gram|ss))<=.35,'five-gram similarity requires coordinator review',b['id']+'|'+other)
                ngrams.append((b['id'],gram))
            if b['formula'] and b['templateId']!='math.constraint':
                f=b['formula'];expr=f['display'].split(':',1)[1].strip()
                require(parse(expr)==f['ast'],'exact printed AST',b['id'])
                bindings={v['symbol']:v for v in f['variables']}
                if b['templateId']=='math.rule':
                    recipe='W3' if family['classId']=='E2' else ['Q','D','A','W','P'][(family['familyId']+facts['number']-1)%5]
                    require([c for c in f['constraints'] if c.startswith('recipe=')]==['recipe='+recipe],'recipe schedule',b['id'])
                    def shape(n):return (n['op'],tuple(shape(x) for x in n.get('args',[])))
                    if recipe!='W3':
                        required=next(x['ast'] for x in spec['formula_shape_library'] if x['id']==recipe)
                        require(shape(f['ast'])==shape(required),'recursive recipe shape',b['id'])
                    else:
                        rhs=f['ast']['args'][1]
                        require(rhs['op']=='divide' and rhs['args'][0]['op']=='add' and rhs['args'][1]['op']=='add' and len(rhs['args'][0]['args'])==len(rhs['args'][1]['args'])==3 and all(x['op']=='multiply' and len(x['args'])==2 for x in rhs['args'][0]['args']),'three-term weighted structure',b['id'])
                    expected_values=dict(m=(str(facts['readings'][0]),'g'),n=(str(facts['readings'][1]),'g'),t=(str(facts['durations'][0]),'s'),c=(facts['gain'],'g/V' if recipe=='A' else 'g'),v=(facts['voltage'],'V'),u=(facts['reference'],'V'),d=(facts['offset'],'g'))
                    if recipe=='P':expected_values['n']=(facts['exponent'],'1')
                    for j in range(3):
                        expected_values[f'w_{j+1}']=(facts['weights'][j],'1')
                        expected_values[f'x_{j+1}']=(str(Decimal(facts['readings'][j])+Decimal(j)/10),'g')
                    for name,v in bindings.items():
                        if name=='z':continue
                        require(name in expected_values and (Decimal(v['valueDecimal']),dimension(v['unit']))==(Decimal(expected_values[name][0]),dimension(expected_values[name][1])),'formula operand world binding',b['id']+'|'+name)
                else:
                    require(bindings['a']['valueDecimal']==str(facts['readings'][0]) and bindings['b']['valueDecimal']==str(facts['readings'][1]),'mini formula world binding',b['id'])
                value,dims=evaluate(f['ast']['args'][1],bindings)
                rounded=(Decimal(value.numerator)/Decimal(value.denominator)).quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
                require(rounded==Decimal(f['valueDecimal']),'exact rational result',b['id'])
                require(dims==dimension(bindings[f['ast']['args'][0]['name']]['unit']),'result unit',b['id'])
            if b['templateId'] in ['matrix.table','discussion.mini-table']:
                shape=next(t['table_shape'] for t in spec['enriched_derivatives'][family['classId']]['layouts'][family['layoutId']]['blocks'] if t['id']==b['templateId'])
                require(len(b['cells'])==shape['semantic_cell_count'],'semantic cell count',b['id'])
                for cell in b['cells']:
                    if cell['row'] in shape['header_rows'] or cell['column']==0:continue
                    if b['templateId']=='discussion.mini-table' and cell['column']==2:continue
                    j=cell['row']-len(shape['header_rows']);col=cell['column']
                    if b['templateId']=='discussion.mini-table':expected=Decimal(facts['readings'][j])
                    elif family['classId']=='E2':
                        mass=Decimal(facts['readings'][j])+Decimal(j)/10
                        expected=Decimal(facts['durations'][j]) if col==1 else mass if col==2 else (mass/Decimal(facts['durations'][j])).quantize(Decimal('.001'),rounding=ROUND_HALF_UP)
                    else:expected=Decimal(facts['durations'][j]) if col==1 else Decimal(facts['readings'][j]) if col==2 else (Decimal(facts['readings'][j])/Decimal(facts['durations'][j])).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
                    require(Decimal(cell['value'])==expected,'typed table world value',b['id'])
                require(b['displayText'].count('|')==shape.get('display_separator_count',0),'exact pipe count',b['id'])
            if b['chart']:
                chart=b['chart'];require([s['yDecimals'] for s in chart['data']]==facts['chartSeries'],'chart world binding',b['id'])
                require(len([t for t in chart['ticks'] if t['axis']=='x'])==8 and 4<=len([t for t in chart['ticks'] if t['axis']=='y'])<=6,'chart ticks',b['id'])
                require(len(chart['legend'])==2 and all(len(s['xDecimals'])==len(s['yDecimals'])==8 for s in chart['data']),'chart dimensions',b['id'])
        for leaf in plan['leaves']:
            require(contains(leaf['containerPt'],leaf['expectedSupportPt']),'leaf containment',leaf['id'])
            for g in leaf['glyphs']:
                font=next(f for f in FONTS.values() if f.hash==g['fontHash'])
                actual=font.run('independent',g['text'],g['baselinePt'],g['sizePt'],g['logicalOffset'],g['rotationDegrees'])[0]
                require(actual['expectedInkPt']==g['expectedInkPt'],'independent font recomputation',g['id'])
        if family['classId']=='E5':
            cover=lookup['overlay.cover']['bboxPt']
            for k in [2,3]:
                box=lookup[f'overlay.row.{k}']['bboxPt'];require(contains([cover[0]+1,cover[1]+1,cover[2]-1,cover[3]-1],box),'cover safety',pid)
            for k in [0,1,4]:
                box=lookup[f'overlay.row.{k}']['bboxPt'];require(not area(intersect([cover[0]-1,cover[1]-1,cover[2]+1,cover[3]+1],box)),'visible row clearance',pid)
            for b in page['blocks']:
                if not b['templateId'].startswith('overlay.') and b['glyphs']:
                    require(not area(intersect(cover,b['bboxPt'])),'cover touches parent',b['id'])
    return dict(passed=not misses,misses=misses)


def native_glyphs(doc,page):
    fonts={}
    for row in page.get_fonts(full=True):
        xref,ext,typ,name=row[:4]
        extracted=doc.extract_font(xref)
        if not extracted[3]:continue
        try:
            font=TTFont(BytesIO(extracted[3]));fonts[name]=font,extracted[3]
        except Exception:continue
    glyphs=[];font_receipts={}
    for trace in page.get_texttrace():
        key=trace['font'].split('+')[-1]
        candidates=[(name,v) for name,v in fonts.items() if re.sub('[^a-z]','',name.split('+')[-1].lower())==re.sub('[^a-z]','',key.lower())]
        if not candidates:raise ValueError(('Cannot bind actual native font',key,list(fonts)))
        # Writer emits several subsets with the same PostScript family name.
        # Bind the native trace's actual GIDs to the embedded outlines, rather
        # than conflating those resources. Unicode comes from actual ToUnicode;
        # the pinned font establishes identity, never authoring geometry.
        reference=FONTS['mono' if 'Mono' in key else 'sans']
        matching=[]
        for name,(candidate,raw) in candidates:
            up=candidate['head'].unitsPerEm;gs=candidate.getGlyphSet();valid=True
            for cp,gid,origin,bbox in trace['chars']:
                if chr(cp).isspace():continue
                if gid>=candidate['maxp'].numGlyphs:valid=False;break
                gn=candidate.getGlyphName(gid);pen=BoundsPen(gs);gs[gn].draw(pen)
                original=reference.glyph(chr(cp))
                actual_bounds=tuple(v/up for v in pen.bounds) if pen.bounds else None
                original_bounds=tuple(v/reference.upem for v in original[3]) if original[3] else None
                if actual_bounds!=original_bounds:valid=False;break
            if valid:matching.append((name,candidate,raw))
        if not matching:raise ValueError(('No embedded subset matches actual Unicode/GIDs',key,[(chr(c[0]),c[1]) for c in trace['chars'][:12]]))
        resource,font,raw=matching[0]
        font_receipts[resource]=digest(raw)
        gs=font.getGlyphSet();upem=font['head'].unitsPerEm;size=trace['size'];dx,dy=trace['dir']
        for cp,gid,origin,bbox in trace['chars']:
            char=chr(cp)
            if char.isspace():continue
            name=font.getGlyphName(gid);pen=BoundsPen(gs);gs[name].draw(pen)
            if pen.bounds is None:raise ValueError(('Meaningful glyph lacks actual outline',char,gid,key))
            a,b,c,d=[v*size/upem for v in pen.bounds]
            x,y=origin
            pts=[(x+xx*dx+yy*dy,y+xx*dy-yy*dx) for xx,yy in [(a,b),(a,d),(c,b),(c,d)]]
            ink=[min(x for x,y in pts),min(y for x,y in pts),max(x for x,y in pts),max(y for x,y in pts)]
            glyphs.append(dict(text=char,gid=gid,font=key,size=size,origin=list(origin),ink=ink,dir=[dx,dy],seqno=trace['seqno'],color=list(trace['color']),opacity=trace.get('opacity',1)))
    return glyphs,font_receipts


def native_check(authoring,plans,path,directory):
    misses=[];results=[]
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    with fitz.open(path) as doc:
        if len(doc)!=10:misses.append(dict(kind='page count',actual=len(doc)))
        for page,auth,plan in zip(doc,authoring['pages'],plans):
            actual,font_hashes=native_glyphs(doc,page)
            expected=[g for leaf in plan['leaves'] for g in leaf['glyphs'] if not g['text'].isspace()]
            require_counts=Counter(g['text'] for g in expected)==Counter(g['text'] for g in actual)
            if not require_counts:misses.append(dict(page=auth['id'],kind='exact native glyph multiset',missing=dict(Counter(g['text'] for g in expected)-Counter(g['text'] for g in actual)),extra=dict(Counter(g['text'] for g in actual)-Counter(g['text'] for g in expected))))
            unmatched=set(range(len(actual)));matches={};minimum=1;minimum_leaf=1;minimum_parent=1
            for g in expected:
                candidates=[i for i in unmatched if actual[i]['text']==g['text']]
                if not candidates:continue
                i=min(candidates,key=lambda i:math.dist(actual[i]['origin'],g['baselinePt']))
                unmatched.remove(i);a=actual[i];score=iou(g['expectedInkPt'],a['ink']);minimum=min(minimum,score);matches[g['id']]=a['ink']
                # The contract's 0.70 gate applies to the support-plan leaves,
                # blocks and semantic parents. Per-codepoint IoU is diagnostic;
                # every glyph still has exact presence, size and origin checks.
                if math.dist(a['origin'],g['baselinePt'])>2 or abs(a['size']-g['sizePt'])>.3:
                    misses.append(dict(page=auth['id'],id=g['id'],text=g['text'],kind='native ink/font/origin',IoU=score,expected=g['expectedInkPt'],actual=a['ink'],origin=a['origin'],baseline=g['baselinePt'],size=a['size']))
            drawings=page.get_drawings();native_lines=[]
            for d in drawings:
                for item in d['items']:
                    if item[0]=='l':
                        p,q=item[1:];native_lines.append(([p.x,p.y,q.x,q.y],d.get('width',.3)))
            actual_leaf_supports={}
            for leaf in plan['leaves']:
                boxes=[matches[g['id']] for g in leaf['glyphs'] if g['id'] in matches]
                for path in leaf['primitivePaths']:
                    if not path.startswith('M'):continue
                    line=[float(x) for x in re.findall(r'-?\d+(?:\.\d+)?',path)][:4]
                    def distance(pair):
                        p,w=pair
                        return min(max(abs(x-y) for x,y in zip(p,line)),max(abs(x-y) for x,y in zip(p[2:]+p[:2],line)))
                    nearest=min(native_lines,key=distance) if native_lines else None
                    if nearest is None or distance(nearest)>.5:
                        misses.append(dict(id=leaf['id'],kind='missing primitive support'));continue
                    p,width=nearest;x,y,a,b=p
                    boxes.append([min(x,a)-width/2,min(y,b)-width/2,max(x,a)+width/2,max(y,b)+width/2])
                if leaf['kind']=='frame':
                    candidates=[list(d['rect']) for d in drawings if d.get('fill') is not None]
                    candidates += [list(rect) for image in page.get_images(full=True) for rect in page.get_image_rects(image[0])]
                    candidate=max(candidates,key=lambda b:iou(b,leaf['expectedSupportPt'])) if candidates else None
                    if candidate is None or iou(candidate,leaf['expectedSupportPt'])<.7:misses.append(dict(id=leaf['id'],kind='physical footprint missing'))
                    else:boxes.append(candidate)
                if boxes:
                    actual_leaf_supports[leaf['id']]=union(boxes)
                    score=iou(leaf['expectedSupportPt'],union(boxes));minimum_leaf=min(minimum_leaf,score)
                    if score<.7:misses.append(dict(id=leaf['id'],kind='leaf IoU',actual=score))
            for b in auth['blocks']:
                boxes=[matches[g['id']] for g in b['glyphs'] if g['id'] in matches]
                if boxes:
                    expected_boxes=[g['bboxPt'] for g in b['glyphs'] if not g['text'].isspace()]
                    score=iou(union(expected_boxes),union(boxes))
                    if score<.7:misses.append(dict(id=b['id'],kind='block occupied-support IoU',actual=score))
            spec=json.loads((CLEAN/'spec-a5.json').read_text());class_id,layout_id=auth['layoutContractId'].split('-')
            groups=spec['enriched_derivatives'][class_id]['layouts'][layout_id]['semantic_regions']
            groups={**groups,'discussion-parent':[b['templateId'] for b in auth['blocks'] if b['templateId'].startswith('discussion.') and b['glyphs']]}
            for name,tids in groups.items():
                bids=[auth['id']+'.'+tid for tid in tids]
                relevant=[leaf for leaf in plan['leaves'] if leaf['glyphs'] or leaf['kind']=='primitive' if any(leaf['id']==bid or leaf['id'].startswith(bid+'.') for bid in bids)]
                boxes=[actual_leaf_supports[leaf['id']] for leaf in relevant if leaf['id'] in actual_leaf_supports]
                if relevant and boxes:
                    score=iou(union(leaf['expectedSupportPt'] for leaf in relevant),union(boxes));minimum_parent=min(minimum_parent,score)
                    if score<.7:misses.append(dict(page=auth['id'],group=name,kind='semantic parent IoU',actual=score))
            # Every page gets a real 300 DPI raster; retained close-ups show
            # equations/table and challenging inset or cover at readable scale.
            pix=page.get_pixmap(dpi=300,alpha=False)
            raster=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,pix.n)
            scale=300/72
            visible_ids={g['id'] for leaf in plan['leaves'] if leaf['visible'] for g in leaf['glyphs'] if not g['text'].isspace()}
            for gid in visible_ids:
                if gid not in matches:continue
                x,y,a,b=matches[gid];x0=max(0,math.floor(x*scale));y0=max(0,math.floor(y*scale));x1=min(pix.width,math.ceil(a*scale));y1=min(pix.height,math.ceil(b*scale))
                tile=raster[y0:y1,x0:x1,:3]
                if not tile.size or not np.any(np.max(tile,axis=2)<150):misses.append(dict(id=gid,kind='visible native glyph has no dark rendered ink'))
            # Independently locate actual opaque covers and assert their paint
            # order and actual render color; expected row boxes never stand in
            # for a physical cover found in the output.
            if any(b['templateId']=='overlay.cover' for b in auth['blocks']):
                cover=next(b for b in auth['blocks'] if b['templateId']=='overlay.cover');bb=cover['containerPt']
                candidates=[d for d in page.get_drawings() if d.get('fill') and iou(list(d['rect']),bb)>.99 and d.get('fill_opacity',1)==1]
                if len(candidates)!=1:misses.append(dict(page=auth['id'],kind='actual opaque cover count',actual=len(candidates)))
                else:
                    d=candidates[0]
                    if max(abs(a-b) for a,b in zip(d['fill'],[.88,.89,.9]))>.005:misses.append(dict(page=auth['id'],kind='cover color',actual=d['fill']))
                    for leaf in plan['leaves']:
                        if '.overlay.row.' in leaf['id'] and not leaf['visible']:
                            indices=[next((a['seqno'] for a in actual if a['text']==g['text'] and math.dist(a['origin'],g['baselinePt'])<2),10**9) for g in leaf['glyphs'] if not g['text'].isspace()]
                            if indices and max(indices)>=d['seqno']:misses.append(dict(id=leaf['id'],kind='cover painted before hidden glyph'))
                    px=round((bb[0]+bb[2])*scale/2);py=round((bb[1]+bb[3])*scale/2)
                    color=raster[py,px,:3].astype(float)/255
                    if max(abs(a-b) for a,b in zip(color,[.88,.89,.9]))>.01:misses.append(dict(page=auth['id'],kind='actual cover raster color',actual=color.tolist()))
            if auth['number'] in [1,3,8]:
                pix.save(directory/f'{auth["id"]}.png')
                for suffix in ['matrix.table','math.rule','discussion.frame']:
                    box=next(b['containerPt'] for b in auth['blocks'] if b['templateId']==suffix)
                    page.get_pixmap(dpi=300,clip=fitz.Rect(box)+(-2,-2,2,2),alpha=False).save(directory/f'{auth["id"]}.{suffix}.png')
            results.append(dict(pageId=auth['id'],expectedMeaningfulGlyphs=len(expected),actualMeaningfulGlyphs=len(actual),minGlyphIoU=minimum,minLeafIoU=minimum_leaf,minSemanticParentIoU=minimum_parent,actualEmbeddedFontHashes=font_hashes,rasterDpi=300,renderHash=digest(pix.samples)))
    return dict(passed=not misses,misses=misses,pages=results,source='independent actual PDF font resources, glyph IDs, origins and 300 DPI MuPDF render')
