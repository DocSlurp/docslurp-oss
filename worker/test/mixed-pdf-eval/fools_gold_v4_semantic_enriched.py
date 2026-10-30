"""E1–E5 bindings independently derived from frozen world facts and contracts.

No rendering/generator dependency: each printed expression is parsed before its
AST, dimensions, operands and result are checked. Geometry is checked separately.
"""
from decimal import Decimal, ROUND_HALF_UP
import re
from fools_gold_v4_common import norm, contains, intersection, area
from fools_gold_v4_semantic import decimal, unit, typed_value, rounding, require_same_unit, _symbol


def same(a,b,message):
    if a!=b:raise ValueError(message)


def node(kind,*args):return dict(op=kind,args=list(args))


def expression(text):
    """Parse the supported printed math grammar; never evaluate host code."""
    text=text.replace('−','-')
    tokens=re.findall(r'[A-Za-z]+(?:_?[0-9]+)?|[0-9]+(?:\.[0-9]+)?|[()+*/^=―-]',text)
    if ''.join(tokens)!=re.sub(r'\s+','',text):raise ValueError('unrecognized printed math token')
    index=0
    def atom():
        nonlocal index
        if index>=len(tokens):raise ValueError('incomplete expression')
        t=tokens[index];index+=1
        if t=='(':
            v=expr(0)
            if index>=len(tokens) or tokens[index]!=')':raise ValueError('unclosed expression')
            index+=1;return v
        if re.fullmatch(r'[A-Za-z]+(?:_?[0-9]+)?',t):return _symbol(re.sub(r'([A-Za-z]+)([0-9]+)$',r'\1_\2',t))
        if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?',t):return dict(op='constant',valueDecimal=t)
        raise ValueError('unexpected math token '+t)
    precedence={'=':1,'+':2,'-':2,'*':3,'/':3,'^':4}
    names={'=':'equal','+':'add','-':'subtract','*':'multiply','/':'divide','^':'power'}
    def expr(minimum):
        nonlocal index
        left=atom()
        while index<len(tokens) and tokens[index] in precedence and precedence[tokens[index]]>=minimum:
            t=tokens[index];index+=1
            right=expr(precedence[t]+(0 if t=='^' else 1));kind=names[t]
            # Addition is n-ary in the immutable AST schema.
            if kind=='add' and left['op']=='add':left=node(kind,*left['args'],right)
            else:left=node(kind,left,right)
        return left
    result=expr(0)
    if index!=len(tokens):raise ValueError('unused expression tokens')
    return result


def latex_expression(text):
    text=re.sub(r'\\mathrm\{(\w+)\}',r'\1',text).replace(r'\delta','delta').replace(r'\,','*')
    text=re.sub(r'([A-Za-z])_\{([0-9]+)\}',r'\1_\2',text)
    # Resolve each fraction with balanced braces, including nested fractions.
    while re.search(r'\\(?:d?frac)\{',text):
        m=re.search(r'\\(?:d?frac)\{',text);pos=m.end()-1
        groups=[]
        for _ in range(2):
            if pos>=len(text) or text[pos]!='{':raise ValueError('missing fraction group')
            start=pos+1;depth=1;pos+=1
            while depth and pos<len(text):
                if text[pos]=='{':depth+=1
                elif text[pos]=='}':depth-=1
                pos+=1
            if depth:raise ValueError('unclosed fraction')
            groups.append(text[start:pos-1])
        text=text[:m.start()]+'(('+groups[0]+')/('+groups[1]+'))'+text[pos:]
    # LaTeX adjacency means multiplication. Preserve named symbols.
    text=re.sub(r'(w_[0-9]+)\s+(x_[0-9]+)',r'\1*\2',text)
    text=text.replace('{','(').replace('}',')')
    return expression(text)


def rich_literal(text,recipe):
    printed=norm(text).split(':',1)[-1].strip()
    # Fraction bars and reduced subscript glyphs carry spatial syntax. This
    # adapter assigns only that syntax; operand names/order remain parsed.
    if recipe in ['Q','D','W','W3']:
        parts=printed.split('=')
        if len(parts)!=2 or parts[1].count('―')!=1:raise ValueError('missing equality/fraction bar')
        a,b=parts[1].split('―');a=re.sub(r'(w[0-9]+)\s*(x[0-9]+)',r'\1*\2',a)
        return expression(parts[0]+'=('+a+')/('+b+')')
    if recipe=='A':return expression(re.sub(r'\bg\s+v\b','g*v',printed))
    if recipe=='P':
        m=re.fullmatch(r'(\w+)\s*=\s*(\w+)\s*\(\s*(\w+)\s*―\s*(\w+)\s*\)\s*(\w+)',printed)
        if not m:raise ValueError('invalid printed power expression')
        q,g,v,u,n=m.groups();return expression(f'{q}={g}*({v}/{u})^{n}')
    raise ValueError('unknown recipe')


def rich_formula(block,facts,family):
    recipe='W3' if family['classId']=='E2' else ['Q','D','A','W','P'][(family['familyId']+facts['number']-1)%5]
    formulas={'Q':'q=a/b','D':'q=(a-b)/b','A':'q=g*v+h','W':'q=(w1*x1+w2*x2)/(w1+w2)','W3':'q=(w1*x1+w2*x2+w3*x3)/(w1+w2+w3)','P':'q=g*(v/u)^n'}
    expected=expression(formulas[recipe]);f=block['formula']
    bounds={'Q':(18,36),'D':(22,44),'A':(20,42),'W':(28,48),'P':(22,44),'W3':(24,62)}[recipe]
    if not bounds[0]<=len(norm(block['displayText']))<=bounds[1]:raise ValueError('printed expression exceeds recipe character contract')
    same(f['ast'],expected,'AST recipe differs from declared family/page recipe')
    same(rich_literal(block['displayText'],recipe),expected,'printed operands/order differ from recipe')
    latex=f['latex'];prefix=re.match(r'Rule\\ ([0-9]{2}):\\ ',latex)
    if not prefix or int(prefix[1])!=facts['number']:raise ValueError('LaTeX page/prefix differs')
    same(latex_expression(latex[prefix.end():]),expected,'LaTeX differs from printed AST')
    same(f['display'],block['displayText'],'formula display differs')
    declarations=[v[7:] for v in f['constraints'] if v.startswith('recipe=')]
    same(declarations,[recipe],'recipe binding missing/ambiguous')
    variables={v['symbol']:v for v in f['variables']};same(len(variables),len(f['variables']),'duplicate variables')
    symbols=set()
    def visit(ast):
        if ast['op']=='symbol':symbols.add(ast['name'])
        for child in ast.get('args',[]):visit(child)
    visit(expected);same(set(variables),symbols,'unused/unresolved variables')
    values={k:decimal(v) for k,v in facts['formulaFacts'].items()}
    values.update(a=decimal(facts['readings'][0]),b=decimal(facts['durations'][0] if recipe=='Q' else facts['readings'][1]))
    for j in range(3 if recipe=='W3' else 2 if recipe=='W' else 0):
        expected_sample=decimal(facts['readings'][j])+(Decimal(j)/10 if recipe=='W3' else Decimal(0))
        same(values[f'x_{j+1}'],expected_sample,'weighted sample differs from its printed observation row')
    units={k:'1' for k in values};units.update(a='g',b='s' if recipe=='Q' else 'g',x_1='g',x_2='g',x_3='g',v='V',u='V',g='g/V' if recipe=='A' else 'g',h='g')
    for name in symbols-{'q'}:
        same(decimal(variables[name]['valueDecimal']),values[name],'operand not bound to world: '+name)
        require_same_unit(variables[name]['unit'],units[name],'world operand '+name)
        if name.startswith('w_') or name in ['n','u'] or (name=='b' and recipe in ['Q','D']):
            if values[name]<=0:raise ValueError('nonpositive denominator/weight/power parameter')
    if recipe=='P':
        same([c for c in f['constraints'] if c.startswith('v interval=')],['v interval=[0.1,100] V'],'missing/altered finite power interval')
        if not Decimal('0.1')<=values['v']<=Decimal('100'):raise ValueError('v outside documented finite interval [0.1,100] V')
    value,dimensions=typed_value(expected['args'][1],variables)
    result=value.quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
    same(rounding(f),6,'rich precision differs');same(decimal(f['absoluteTolerance']),Decimal('.000001'),'rich tolerance differs')
    same(unit(variables['q']['unit']),dimensions,'result dimensions differ')
    same(decimal(variables['q']['valueDecimal']),result,'bound result differs')
    same(decimal(f['valueDecimal']),result,'result differs from world calculation')


def table_e2(table,facts):
    cells={(c['row'],c['column']):c for c in table['cells']}
    expected={(r,c) for r in range(8) for c in range(4)}-{(0,2)}
    same(len(cells),31,'E2 semantic cell count differs');same(set(cells),expected,'E2 cell coverage differs')
    headers=[['Record','Readouts',None,'Rate/s'],['Item-ID','Span-s','Mass-g','Gain-g/s']]
    for (r,c),cell in cells.items():
        same((cell['rowSpan'],cell['columnSpan']),(1,2 if (r,c)==(0,1) else 1),'merged span differs')
        if r<2:
            same(cell['displayText'],headers[r][c],'printed header differs from column quantity contract')
            same(cell['unit'],'label','header has numeric data units');same(cell['value'],cell['displayText'],'header value differs')
        else:
            i=r-2;duration=decimal(facts['durations'][i%4])+Decimal(i)/10;reading=decimal(facts['readings'][i%4])+Decimal(i)/10
            values=[f'R{facts["number"]:02d}{i:04d}',f'{duration:07.2f}',f'{reading:07.2f}',f'{reading/duration:05.2f}']
            same(cell['displayText'],values[c],'enriched row differs from world');same(cell['value'],values[c],'typed row differs')
            if c:require_same_unit(cell['unit'],['identifier','s','g','g/s'][c],'E2 column')
            else:same(cell['unit'],'identifier','E2 identifier unit differs')
    same(table['displayText'],'\n'.join(' '.join(cells[r,c]['displayText'] for c in range(4) if (r,c) in cells) for r in range(8)),'printed table differs from cells')


def page_extras(blocks,facts,family):
    cid=family['classId']
    if cid=='E3':
        b=blocks['chart'];chart=b['chart'];same(chart['kind'],'line','chart kind differs')
        same(chart['data'],facts['chartFacts'],'chart series values/units/names differ from world')
        same(len(chart['data']),2,'chart series count differs')
        for series in chart['data']:
            same(series['xDecimals'],[str(i) for i in range(1,9)],'chart x sequence differs')
            same(len(series['yDecimals']),8,'chart point count differs')
            same(series['unitX'],'window','chart x unit differs');same(series['unitY'],'%','chart y unit differs')
            for value in series['yDecimals']:
                if not Decimal(0)<=decimal(value)<=Decimal(100):raise ValueError('chart point outside printed percent axis')
        same(chart['title'],'Response over inspection window','chart title binding differs')
        same(chart['axisTitles'],['Window index','Response (%)'],'axis labels/unit binding differs')
        same([(t['axis'],t['displayText'],decimal(t['valueDecimal'])) for t in chart['ticks']], [('x',str(v),Decimal(v)) for v in range(1,9)]+[('y',str(v),Decimal(v)) for v in [0,25,50,75,100]],'tick text/value/axes differ')
        same([(v['seriesIndex'],v['displayText']) for v in chart['legend']],[(i,v['name']) for i,v in enumerate(facts['chartFacts'])],'legend/series binding differs')
        text=[chart['title'],*chart['axisTitles'],*[t['displayText'] for t in chart['ticks']],*[v['displayText'] for v in chart['legend']]]
        same(b['displayText'],'\n'.join(text),'chart printed labels differ')
        same(chart['captionBlockId'],blocks['chart.caption']['id'],'caption unresolved')
        same(chart['textGlyphIds'],[g['id'] for g in b['glyphs']],'chart glyph binding differs')
        for child in chart['ticks']+chart['legend']:
            if not contains(b['bboxPt'],child['bboxPt']):raise ValueError('chart label outside chart')
    if cid=='E4':
        table=blocks['discussion.mini-table'];cells={(c['row'],c['column']):c for c in table['cells']}
        same(set(cells),{(r,c) for r in range(4) for c in range(3)},'nested table coverage differs')
        expected=[['Position','Reading','Unit']]+[[f'Zone {i+1}',f'{facts["readings"][i]}.0','grams'] for i in range(3)]
        for (r,c),cell in cells.items():
            same((cell['rowSpan'],cell['columnSpan']),(1,1),'nested span differs');same(cell['visible'],True,'nested visibility differs')
            same(cell['displayText'],expected[r][c],'nested cell/world differs');same(cell['value'],expected[r][c],'nested typed value differs')
            if r and c==1:require_same_unit(cell['unit'],'g','nested reading')
            else:same(cell['unit'],'identifier' if r and c==0 else 'label','nested label/identifier unit differs')
        same(table['displayText'],'\n'.join(' '.join(row) for row in expected),'nested table print differs')
        b=blocks['discussion.mini-math'];f=b['formula'];expected_ast=expression('delta=late-early')
        same(expression(norm(b['displayText']).split(':')[-1]),expected_ast,'nested literal differs')
        same(f['ast'],expected_ast,'nested AST differs');same(latex_expression(f['latex']),expected_ast,'nested LaTeX differs')
        v={a['symbol']:a for a in f['variables']};same(len(v),3,'nested variables differ');same(set(v),{'delta','early','late'},'nested variable names differ')
        result=decimal(facts['readings'][1])-decimal(facts['readings'][0])
        for name,value in [('early',decimal(facts['readings'][0])),('late',decimal(facts['readings'][1])),('delta',result)]:
            same(decimal(v[name]['valueDecimal']),value,'nested operand/world differs');require_same_unit(v[name]['unit'],'g','nested operand')
        typed_value(f['ast'],v);same(decimal(f['valueDecimal']),result,'nested result differs');same(decimal(f['absoluteTolerance']),Decimal(0),'nested tolerance differs')
        frame=blocks['discussion.frame']['bboxPt']
        for name in ['discussion.title','discussion.excerpt','discussion.commentary','discussion.mini-table','discussion.mini-math']:
            if not contains(frame,blocks[name]['bboxPt']):raise ValueError('nested content outside complete screenshot frame')
    if cid=='E5':
        cover=blocks['overlay.cover'];card=blocks['overlay.card']
        same(cover['role'],'occluder','cover role differs')
        if not contains(card['bboxPt'],cover['bboxPt']):raise ValueError('cover outside auxiliary card')
        for i in range(5):
            b=blocks[f'overlay.row.{i}'];visible=i in [0,1,4]
            same(b['visible'],visible,'partial row visibility differs')
            if not contains(card['bboxPt'],b['bboxPt']):raise ValueError('row outside card')
            for g in b['glyphs']:
                same(g['visible'],visible,'partial glyph visibility differs')
                if visible and area(intersection(g['bboxPt'],cover['bboxPt'])):raise ValueError('cover touches visible row')
                if not visible and not(contains(cover['bboxPt'],g['bboxPt']) and cover['zOrder']>b['zOrder']):raise ValueError('hidden glyph not wholly covered at higher z')
            same(norm(b['displayText']),facts['overlayRows'][i],'auxiliary row print/world binding differs')
        for name in ['body.1','body.2','matrix.table','math.rule','math.constraint','discussion.title','discussion.excerpt','discussion.commentary']:
            for g in blocks[name]['glyphs']:
                if area(intersection(g['bboxPt'],cover['bboxPt'])):raise ValueError('partial cover touches parent meaningful content')
