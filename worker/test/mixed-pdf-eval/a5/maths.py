"""Small exact AST algebra and a fixed-size rich equation layout engine."""
import ast
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
import re
from support import FONTS


def parse(text):
    def visit(n):
        if isinstance(n, ast.Name):return dict(op='symbol',name=n.id)
        if isinstance(n, ast.Constant) and type(n.value) in (int,float):return dict(op='constant',valueDecimal=str(n.value))
        if isinstance(n, ast.BinOp):
            op = {ast.Add:'add',ast.Sub:'subtract',ast.Mult:'multiply',ast.Div:'divide',ast.Pow:'power'}[type(n.op)]
            a,b=visit(n.left),visit(n.right)
            return dict(op=op,args=a['args']+[b] if op=='add' and a['op']==op else [a,b])
        raise ValueError('Unsupported expression AST')
    left,right = text.split('=')
    return dict(op='equal',args=[visit(ast.parse(left.strip(),mode='eval').body),visit(ast.parse(right.strip().replace('^','**'),mode='eval').body)])


def dimension(unit):
    if unit == '1':return {}
    if '/' in unit:
        a,b=unit.split('/')
        out=dimension(a)
        for k,v in dimension(b).items():out[k]=out.get(k,0)-v
        return {k:v for k,v in out.items() if v}
    return {unit:1}


def evaluate(n, variables):
    if n['op']=='symbol':
        v=variables[n['name']];return Fraction(v['valueDecimal']),dimension(v['unit'])
    if n['op']=='constant':return Fraction(n['valueDecimal']),{}
    vals=[evaluate(a,variables) for a in n['args']]; op=n['op']
    if op in ('add','subtract'):
        assert all(d==vals[0][1] for v,d in vals), 'Incompatible additive units'
        return (sum(v for v,d in vals) if op=='add' else vals[0][0]-vals[1][0]),vals[0][1]
    if op in ('multiply','divide'):
        value=Fraction(1);dims={}
        for i,(v,d) in enumerate(vals):
            sign=-1 if op=='divide' and i else 1
            assert sign==1 or v!=0, 'Zero denominator'
            value=value*v if sign==1 else value/v
            for k,e in d.items():dims[k]=dims.get(k,0)+sign*e
        return value,{k:v for k,v in dims.items() if v}
    if op=='power':
        (v,d),(n,nd)=vals
        assert nd=={} and n.denominator==1 and n>0
        return v**int(n),{k:e*int(n) for k,e in d.items()}
    raise ValueError(op)


def formula(family, facts):
    recipe='W3' if family['classId']=='E2' else ['Q','D','A','W','P'][(family['familyId']+facts['number']-1)%5]
    expressions={'Q':'z = m / t','D':'z = (m-n)/n','A':'z = c*v + d','W':'z = (w_1*x_1+w_2*x_2)/(w_1+w_2)',
        'W3':'z = (w_1*x_1+w_2*x_2+w_3*x_3)/(w_1+w_2+w_3)','P':'z = c*(v/u)^n'}
    units={'Q':'g/s','D':'1','A':'g','W':'g','W3':'g','P':'g'}
    values={'m':(str(facts['readings'][0]),'g'),'n':(str(facts['readings'][1]),'g'),
        't':(str(facts['durations'][0]),'s'),'c':(facts['gain'],'g/V' if recipe=='A' else 'g'),
        'v':(facts['voltage'],'V'),'u':(facts['reference'],'V'),'d':(facts['offset'],'g')}
    if recipe=='P':values['n']=(facts['exponent'],'1')
    for j in range(3):
        values[f'w_{j+1}']=(facts['weights'][j],'1')
        values[f'x_{j+1}']=(str(Decimal(facts['readings'][j])+Decimal(j)/10),'g')
    tree=parse(expressions[recipe]);symbols=set()
    def walk(n):
        if n['op']=='symbol':symbols.add(n['name'])
        for a in n.get('args',[]):walk(a)
    walk(tree)
    bindings={k:dict(symbol=k,valueDecimal=values[k][0],unit=values[k][1]) for k in sorted(symbols-{'z'})}
    value,dims=evaluate(tree['args'][1],bindings)
    assert dims==dimension(units[recipe])
    rounded=(Decimal(value.numerator)/Decimal(value.denominator)).quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
    bindings['z']=dict(symbol='z',valueDecimal=str(rounded),unit=units[recipe])
    display=f'Rule {facts["number"]:02d}: '+expressions[recipe]
    latex=expressions[recipe]
    if recipe in ('Q','D','W','W3'):
        numerator,denominator=expressions[recipe].split('=',1)[1].split('/')
        latex=r'z = \frac{'+numerator.strip().strip('()')+'}{'+denominator.strip().strip('()')+'}'
    if recipe=='P':latex=r'z = c\left(\frac{v}{u}\right)^{n}'
    latex=re.sub(r'([wx])_([123])',r'\1_{\2}',latex).replace('*',r'\cdot ')
    constraints=['recipe='+recipe,'rounding=ROUND_HALF_UP; decimal_places=6']
    if recipe=='P':
        constraints += ['v interval=[0.1,100] V','u > 0','n > 0']
        assert Decimal('.1') <= Decimal(facts['voltage']) <= 100
    return dict(display=display,latex=latex,ast=tree,variables=list(bindings.values()),valueDecimal=str(rounded),absoluteTolerance=.000001,constraints=constraints)


def math_runs(formula, box, size=9):
    """All indices/exponents stay at declared size; fractions carry real rules.

    Positions are derived solely from the AST, pinned advances and fixed offsets.
    Each item is (literal,x,baseline,kind,size,rotation) or a stroked line.
    """
    font=FONTS['mono']; asc=font.asc*size; step=font.width(' ',size)
    def compose(items):
        out=[];width=0
        for w,runs,paths in items:
            out.append((width,runs,paths));width+=w
        runs=[];paths=[]
        for dx,rr,pp in out:
            runs.extend((t,x+dx,y,k,s,r) for t,x,y,k,s,r in rr)
            paths.extend([x+dx,y,z+dx,w] for x,y,z,w in pp)
        return width,runs,paths
    def literal(text, dy=0):
        return font.width(text,size),[(text,0,dy,'mono',size,0)],[]
    def layout(n):
        op=n['op']
        if op=='symbol':
            name=n['name']
            if '_' in name:
                a,b=name.split('_');return compose([literal(a),literal(b,2)])
            return literal(name)
        if op=='constant':return literal(n['valueDecimal'])
        args=n['args']
        if op=='divide':
            wa,ra,pa=layout(args[0]);wb,rb,pb=layout(args[1]);w=max(wa,wb)+step
            ra=[(t,x+(w-wa)/2,y,k,s,r) for t,x,y,k,s,r in ra]
            rb=[(t,x+(w-wb)/2,y+12,k,s,r) for t,x,y,k,s,r in rb]
            return w,ra+rb,pa+[[x+(w-wb)/2,y+12,z+(w-wb)/2,v+12] for x,y,z,v in pb]+[[0,3.2,w,3.2]]
        if op=='power':
            w,r,p=layout(args[0]);nw,nr,np=layout(args[1])
            return w+nw,[(t,x,y+3,k,s,rot) for t,x,y,k,s,rot in r]+[(t,x+w,y,k,s,rot) for t,x,y,k,s,rot in nr],[[x,y+3,z,v+3] for x,y,z,v in p]+np
        if op=='equal':
            # Center the left/prefix relative to fraction, with first baseline
            # retained by the numerator at the fixed envelope anchor.
            a=layout(args[0]);b=layout(args[1]);dy=6 if any(True for _ in b[2]) else 0
            a=(a[0],[(t,x,y+dy,k,s,r) for t,x,y,k,s,r in a[1]],a[2])
            eq=literal(' = ',dy)
            return compose([a,eq,b])
        sep={'add':'+','subtract':'-','multiply':'*'}[op]
        parts=[]
        for i,a in enumerate(args):
            if i:parts.append(literal(sep))
            if a['op']=='divide' and op=='multiply':parts.extend([literal('('),layout(a),literal(')')])
            else:parts.append(layout(a))
        return compose(parts)
    prefix=formula['display'].split(':',1)[0]+': '
    w,runs,paths=layout(formula['ast'])
    prefix_dy=6 if paths else 0
    pw=font.width(prefix,size)
    output=[(prefix,box[0],box[1]+asc+prefix_dy,'mono',size,0)]
    output += [(t,x+box[0]+pw,y+box[1]+asc,k,s,r) for t,x,y,k,s,r in runs]
    paths=[[x+box[0]+pw,y+box[1]+asc,z+box[0]+pw,v+box[1]+asc] for x,y,z,v in paths]
    return output,paths
