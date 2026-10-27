"""Semantic validation only: no renderer, extractor, network or corpus writes.

The v4 prototype world stores readings, durations, ratios and interval bounds.
It does not store tolerance or a duration unit. For sealed records, those two
bindings come from the independently hash-pinned source-layout printed text.
During initial authoring the legacy P layout contract defines seconds for A/B
and hours for C; tolerance must still agree across literal/AST/metadata.

There are no accepted document names, expected measurement values or variable
names here. Column roles are the world's typed quantities; printed symbols
determine the AST bindings. Unknown units and unsupported expressions fail.
"""
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, localcontext
from fractions import Fraction
import re

from fools_gold_v4_common import norm, record_hash


NUMBER = r'[+-]?[0-9]+(?:\.[0-9]+)?'
SYMBOL = r'[^\W\d]\w*'


def decimal(value):
    if isinstance(value, bool) or (not isinstance(value,(int,float)) and not re.fullmatch(NUMBER, str(value))):
        raise ValueError('not a finite plain decimal: '+repr(value))
    result=Decimal(str(value))
    if not result.is_finite():raise ValueError('nonfinite quantity')
    return result


@dataclass(frozen=True)
class Unit:
    dimensions: tuple
    scale: Fraction = Fraction(1)

    def multiply(self, other, sign=1):
        dims=dict(self.dimensions)
        for key,power in other.dimensions:dims[key]=dims.get(key,Fraction(0))+sign*power
        scale=self.scale*other.scale if sign==1 else self.scale/other.scale
        return Unit(tuple(sorted((k,v) for k,v in dims.items() if v)),scale)

    def power(self, exponent):
        exponent=Fraction(exponent)
        if self.scale!=1 and exponent.denominator!=1:
            raise ValueError('fractional power of a scaled unit needs an explicit conversion')
        return Unit(tuple((k,v*exponent) for k,v in self.dimensions if v*exponent),
                    self.scale**exponent.numerator if exponent.denominator==1 else Fraction(1))


_ALIASES={}
def _aliases(names,dimension,scale=1):
    value=Unit(((dimension,Fraction(1)),),Fraction(str(scale))) if dimension else Unit(())
    for name in names:_ALIASES[name.casefold()]=value


_aliases(['1','dimensionless'],'')
_aliases(['g','gram','grams'],'mass')
_aliases(['kg','kilogram','kilograms'],'mass',1000)
_aliases(['mg','milligram','milligrams'],'mass','0.001')
_aliases(['um','µm','μm','micrometer','micrometers','micrometre','micrometres'],'length')
_aliases(['mm','millimeter','millimeters'],'length',1000)
_aliases(['m','meter','meters'],'length',1000000)
_aliases(['s','sec','second','seconds'],'time')
_aliases(['min','minute','minutes'],'time',60)
_aliases(['h','hr','hour','hours'],'time',3600)
_aliases(['unit','units','pcs','piece','pieces','count','counts'],'count')
_aliases(['V','volt','volts'],'voltage')


def unit(text):
    text=norm(text)
    if not text:raise ValueError('empty physical unit')
    divisions=text.split('/')
    def product(part):
        factors=[p.strip() for p in part.split('*')]
        if not all(factors):raise ValueError('empty unit factor')
        value=Unit(())
        for factor in factors:
            if factor.casefold() not in _ALIASES:raise ValueError('unknown physical unit: '+factor)
            value=value.multiply(_ALIASES[factor.casefold()])
        return value
    value=product(divisions[0])
    for part in divisions[1:]:value=value.multiply(product(part),-1)
    return value


def require_same_unit(actual,expected,where):
    # A second and an hour share dimensions but have different scales. The
    # unchanged numeric value cannot silently move between those bases.
    if unit(actual)!=unit(expected):raise ValueError(f'{where}: {actual!r} disagrees with {expected!r}')


def typed_value(ast,variables,constant_unit=Unit(())):
    """Evaluate actual expression dimensions and exact decimal quantities."""
    kind=ast['op']
    if kind=='symbol':
        item=variables[ast['name']]
        return decimal(item['valueDecimal']),unit(item['unit'])
    if kind=='constant':return decimal(ast['valueDecimal']),constant_unit
    values=[typed_value(a,variables,constant_unit) for a in ast['args']]
    if kind in ['add','subtract','sum','equal','interval','tolerance','and']:
        if kind=='and':return values
        if not values:raise ValueError('empty typed operation')
        if any(u!=values[0][1] for _,u in values):raise ValueError('incompatible dimensions or scales in '+kind)
        if kind in ['equal','interval','tolerance']:return values
        if kind=='subtract':return values[0][0]-values[1][0],values[0][1]
        return sum((v for v,_ in values),Decimal(0)),values[0][1]
    if kind=='multiply':
        value=Decimal(1);dimensions=Unit(())
        for v,u in values:value*=v;dimensions=dimensions.multiply(u)
        return value,dimensions
    if kind=='divide':
        if values[1][0]==0:raise ValueError('zero denominator')
        return values[0][0]/values[1][0],values[0][1].multiply(values[1][1],-1)
    if kind=='power':
        if values[1][1]!=Unit(()):raise ValueError('exponent must be dimensionless')
        if values[0][0]<=0:raise ValueError('power base must be positive')
        return values[0][0]**values[1][0],values[0][1].power(values[1][0])
    raise ValueError('unsupported typed expression: '+kind)


def _symbol(name):return {'op':'symbol','name':name}


def printed_quotient(text):
    expression=norm(text).split(':',1)[-1].strip()
    match=re.fullmatch(rf'({SYMBOL})\s*=\s*({SYMBOL})\s*/\s*({SYMBOL})',expression)
    if not match:raise ValueError('unsupported printed quotient')
    q,a,b=match.groups()
    if len({q,a,b})!=3:raise ValueError('quotient needs three distinct bound symbols')
    return {'op':'equal','args':[_symbol(q),{'op':'divide','args':[_symbol(a),_symbol(b)]}]}


def latex_quotient(text):
    match=re.fullmatch(rf'\s*({SYMBOL})\s*=\s*\\frac\{{\s*({SYMBOL})\s*\}}\{{\s*({SYMBOL})\s*\}}\s*',text)
    if not match:raise ValueError('unsupported quotient LaTeX')
    q,a,b=match.groups()
    return {'op':'equal','args':[_symbol(q),{'op':'divide','args':[_symbol(a),_symbol(b)]}]}


def printed_interval(text):
    match=re.fullmatch(rf'[^:]+:\s*\[\s*({NUMBER})\s*,\s*({NUMBER})\s*\]\s*([^;]+);\s*tolerance\s*\+/-\s*({NUMBER})\s+(.+)',norm(text))
    if not match:raise ValueError('unsupported printed interval/tolerance')
    lower,upper,reading_unit,tolerance,tolerance_unit=match.groups()
    return dict(lower=decimal(lower),upper=decimal(upper),unit=reading_unit.strip(),
                tolerance=decimal(tolerance),toleranceUnit=tolerance_unit.strip())


def latex_interval(text):
    match=re.fullmatch(rf'\s*\[\s*({NUMBER})\s*,\s*({NUMBER})\s*\]\s*\\pm\s*({NUMBER})\s*',text)
    if not match:raise ValueError('unsupported interval LaTeX')
    return tuple(decimal(v) for v in match.groups())


def rounding(formula):
    matches=[]
    for value in formula['constraints']:
        match=re.fullmatch(r'rounding=(\w+);\s*decimal_places=([0-9]+)',value)
        if match:matches.append(match.groups())
    if len(matches)!=1 or matches[0][0]!='ROUND_HALF_UP':raise ValueError('missing, ambiguous or unsupported rounding declaration')
    places=int(matches[0][1])
    if not 0<=places<=12:raise ValueError('unsupported decimal precision')
    return places


def _plain_header_unit(text,role):
    """An explicit suffix is binding; a bare role inherits its world unit."""
    text=norm(text)
    bracket=re.fullmatch(r'[^\[\]()]+\s*[\[(]([^\[\]()]+)[\])]',text)
    if bracket:return bracket.group(1).strip()
    # Legacy P headers are bare Time/Reading. Explicit unit suffixes are also
    # understood without needing a specific dataset's chosen column wording.
    parts=text.split()
    if len(parts)>1:
        try:unit(parts[-1]);return parts[-1]
        except ValueError:raise ValueError('unknown explicit '+role+' header unit')
    return None


def rate_header(text,reading_unit):
    text=norm(text)
    stem=re.match(r'[A-Za-z]+',text)
    if not stem or stem.group().casefold() not in {'rate','speed','throughput','yield','gain','flow','frequency'}:
        raise ValueError('printed rate header names a different quantity role')
    bracket=_plain_header_unit(text,'rate')
    if bracket:return unit(bracket)
    match=re.fullmatch(r'[^/]+/([^/]+)',text)
    if not match:raise ValueError('rate header must declare a denominator unit')
    denominator=unit(match.group(1))
    if denominator.dimensions!=unit('s').dimensions:raise ValueError('rate header denominator is not time')
    return unit(reading_unit).multiply(denominator,-1)


def _page_blocks(page):
    blocks={}
    for block in page['blocks']:
        key=block['templateId']
        if key in blocks:raise ValueError('ambiguous block role '+key)
        blocks[key]=block
    return blocks


def semantic_checks(record,world,family,printed_reference=None,expected_world_hash=None,
                    equation_precision=6,tolerance_range=None):
    """Bind values and units independently, returning localized failures.

    `printed_reference` is a separately hash-verified source-layout record, not
    a mutable copy of the tested AST. Callers sealing/revalidating a corpus must
    also pin `expected_world_hash` to its manifest. Unsealed authoring can still
    run all relational checks without either optional external anchor.
    """
    misses=[];checks=0
    def check(kind,location,fn):
        nonlocal checks
        checks+=1
        try:fn()
        except (ValueError,KeyError,TypeError,IndexError,ArithmeticError) as error:
            misses.append(dict(kind='semantic-'+kind,location=location,detail=str(error)))
    def same(actual,expected,message):
        if actual!=expected:raise ValueError(message)
    def identity():
        same(record['familyId'],family['familyId'],'authoring family differs')
        same(world['familyId'],family['familyId'],'world belongs to a different family')
        same(record['seed'],family['worldSeed'],'authoring world seed differs')
        same(world['seed'],family['worldSeed'],'world seed differs')
        same(record['layoutId'],family['layoutId'],'layout differs from family contract')
        same(record['split'],family['split'],'split differs from family contract')
        same(record['worldHash'],world['worldHash'],'world reference differs')
        same(world['worldHash'],record_hash(world,'worldHash'),'world self hash differs')
        same(record['authoringHash'],record_hash(record,'authoringHash'),'authoring self hash differs')
        if expected_world_hash is not None:same(world['worldHash'],expected_world_hash,'world differs from immutable manifest anchor')
    check('world-reference','family',identity)
    worldpages={};references={}
    for page in world['pages']:
        if page['number'] in worldpages:misses.append(dict(kind='semantic-world-reference',location='world.pages',detail='duplicate page number'))
        worldpages[page['number']]=page
    if printed_reference:
        references={p['id']:_page_blocks(p) for p in printed_reference['pages']}
    numbers=[p['number'] for p in record['pages']]
    check('world-pages','family',lambda:same(sorted(numbers),sorted(worldpages),'world/authoring page set differs'))
    if len(numbers)!=len(set(numbers)):misses.append(dict(kind='semantic-world-pages',location='family',detail='duplicate authoring page number'))
    for page in record['pages']:
        location=page['id']
        try:
            facts=worldpages[page['number']];blocks=_page_blocks(page);reference=references.get(page['id'])
            if printed_reference and reference is None:raise ValueError('no immutable printed page reference')
            if family['classId']!='P':raise ValueError('this world-to-column binding adapter is for P; enriched instances require their own explicit binding contract')
            table=blocks['matrix.table'];rule=blocks['math.rule'];interval=blocks['math.constraint']
            duration_unit=world.get('durationUnit','h' if family['layoutId']=='C' else 's')
            reading_unit=world['unit'];rate_unit=reading_unit+'/'+duration_unit
            cells={}
            for cell in table['cells']:
                key=(cell['row'],cell['column'])
                if key in cells:raise ValueError('duplicate semantic cell')
                cells[key]=cell
        except (KeyError,ValueError,TypeError) as error:
            misses.append(dict(kind='semantic-binding-contract',location=location,detail=str(error)));continue
        def printed_bindings():
            if reference:
                for key,block in blocks.items():
                    same(norm(block['displayText']),norm(reference[key]['displayText']),'printed reference differs for '+key)
            for key,index in [('body.1',0),('body.2',1),('discussion.excerpt',2),('discussion.commentary',3)]:
                same(norm(blocks[key]['displayText']),norm(facts['prose'][index]),'world prose differs for '+key)
        check('printed-reference',location,printed_bindings)
        def table_bindings():
            expected_rows=len(facts['readings'])
            same(set(cells),{(r,c) for r in range(expected_rows+1) for c in range(4)},'table/world row or column coverage differs')
            same(len(facts['durations']),expected_rows,'duration count differs')
            same(len(facts['ratios']),expected_rows,'ratio count differs')
            lines=table['displayText'].splitlines()
            same(len(lines),expected_rows+1,'printed table row count differs')
            for r,line in enumerate(lines):
                same([norm(v) for v in line.split('|')],[cells[(r,c)]['displayText'] for c in range(4)],'printed table cells disagree with typed cells')
            for c in range(4):
                header=cells[(0,c)]
                same(header['unit'],'label','header has a data unit')
                same(header['value'],header['displayText'],'header value differs from printed header')
            for column,allowed in [(1,{'time','duration','elapsed','dwell','period','span'}),
                                   (2,{'reading','measurement','mass','travel','count','stock','quantity'})]:
                stem=re.match(r'[A-Za-z]+',cells[(0,column)]['displayText'])
                if not stem or stem.group().casefold() not in allowed:raise ValueError('printed header quantity role disagrees with data column '+str(column))
            explicit=_plain_header_unit(cells[(0,1)]['displayText'],'duration')
            if explicit:require_same_unit(explicit,duration_unit,'printed duration header')
            explicit=_plain_header_unit(cells[(0,2)]['displayText'],'reading')
            if explicit:require_same_unit(explicit,reading_unit,'printed reading header')
            same(rate_header(cells[(0,3)]['displayText'],reading_unit),unit(rate_unit),'printed rate denominator/dimensions disagree with world quantity basis')
            for index in range(expected_rows):
                duration=decimal(facts['durations'][index]);reading=decimal(facts['readings'][index])
                if duration<=0:raise ValueError('world duration must be positive')
                ratio=(reading/duration).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
                same(decimal(facts['ratios'][index]),ratio,'world ratio disagrees with its operands')
                for column,expected_value,expected_unit in [(1,duration,duration_unit),(2,reading,reading_unit),(3,ratio,rate_unit)]:
                    cell=cells[(index+1,column)]
                    same(decimal(cell['displayText']),expected_value,'printed numeric cell differs from world fact')
                    same(decimal(cell['value']),expected_value,'typed numeric cell differs from world fact')
                    require_same_unit(cell['unit'],expected_unit,'table column '+str(column))
                    if column==3 and not re.fullmatch(r'[+-]?[0-9]+\.[0-9]',cell['displayText']):raise ValueError('rate must preserve one printed fractional digit')
                same(cells[(index+1,0)]['value'],cells[(index+1,0)]['displayText'],'identifier value/display differ')
                same(cells[(index+1,0)]['unit'],'identifier','identifier has a numeric unit')
        check('table-world-units',table['id'],table_bindings)
        def equation_bindings():
            formula=rule['formula'];literal=printed_quotient(rule['displayText'])
            same(norm(formula['display']),norm(rule['displayText']),'formula display differs')
            same(formula['ast'],literal,'printed quotient operand/order differs from AST')
            same(latex_quotient(formula['latex']),literal,'LaTeX operand/order differs from print')
            q=literal['args'][0]['name'];a,b=[v['name'] for v in literal['args'][1]['args']]
            variables={v['symbol']:v for v in formula['variables']}
            same(len(variables),len(formula['variables']),'duplicate variable bindings')
            same(set(variables),{q,a,b},'unused or unresolved variable')
            precision=rounding(formula)
            same(precision,equation_precision,'rounding precision differs from contract')
            same(decimal(formula['absoluteTolerance']),Decimal(1).scaleb(-precision),'formula computational tolerance differs from declared precision')
            numerator=decimal(facts['readings'][0]);denominator=decimal(facts['durations'][0])
            if denominator<=0:raise ValueError('world denominator must be positive')
            expected=(numerator/denominator).quantize(Decimal(1).scaleb(-precision),rounding=ROUND_HALF_UP)
            for symbol,value,physical_unit in [(a,numerator,reading_unit),(b,denominator,duration_unit),(q,expected,rate_unit)]:
                same(decimal(variables[symbol]['valueDecimal']),value,'formula variable differs from its world/table role: '+symbol)
                require_same_unit(variables[symbol]['unit'],physical_unit,'formula variable '+symbol)
            typed_value(formula['ast'],variables)
            same(decimal(formula['valueDecimal']),expected,'formula result disagrees with world operands')
        check('formula-world-literal-units',rule['id'],equation_bindings)
        def interval_bindings():
            formula=interval['formula'];literal=printed_interval(interval['displayText']);ast=formula['ast']
            same(norm(formula['display']),norm(interval['displayText']),'interval display differs')
            if ast['op']!='and' or [a['op'] for a in ast['args']]!=['interval','tolerance']:raise ValueError('wrong interval/tolerance AST shape')
            same(formula['variables'],[],'prototype interval must bind constant world endpoints')
            if any(n['op']!='constant' for n in ast['args'][0]['args']+ast['args'][1]['args']):raise ValueError('interval endpoints/tolerance must be bound decimal constants')
            lower,upper=[decimal(n['valueDecimal']) for n in ast['args'][0]['args']]
            tolerance=decimal(ast['args'][1]['args'][0]['valueDecimal'])
            if not lower<upper or tolerance<=0:raise ValueError('invalid interval or tolerance')
            same((lower,upper),(decimal(facts['lower']),decimal(facts['upper'])),'AST interval disagrees with world endpoints')
            same((literal['lower'],literal['upper']),(lower,upper),'printed interval disagrees with AST/world endpoints')
            same(literal['tolerance'],tolerance,'printed tolerance disagrees with AST')
            same(decimal(formula['valueDecimal']),tolerance,'typed tolerance value differs')
            same(decimal(formula['absoluteTolerance']),tolerance,'absolute tolerance metadata differs')
            if tolerance_range and not decimal(tolerance_range[0])<=tolerance<=decimal(tolerance_range[1]):raise ValueError('tolerance outside declared range')
            require_same_unit(literal['unit'],reading_unit,'printed interval')
            require_same_unit(literal['toleranceUnit'],reading_unit,'printed tolerance')
            declared=[v.split('=',1)[1] for v in formula['constraints'] if v.startswith('unit=')]
            same(len(declared),1,'ambiguous/missing interval unit declaration')
            require_same_unit(declared[0],reading_unit,'AST interval/tolerance context')
            typed_value(ast,{},unit(declared[0]))
            same(latex_interval(formula['latex']),(lower,upper,tolerance),'interval LaTeX differs from world/literal/AST')
            precision=rounding(formula)
            if tolerance.quantize(Decimal(1).scaleb(-precision),rounding=ROUND_HALF_UP)!=tolerance:raise ValueError('tolerance cannot be represented at its declared precision')
            if reference:
                expected=printed_interval(reference['math.constraint']['displayText'])
                same(literal,expected,'interval/tolerance differs from immutable printed reference')
            if 'tolerance' in facts:same(tolerance,decimal(facts['tolerance']),'tolerance differs from world fact')
            elif 'tolerance' in world:same(tolerance,decimal(world['tolerance']),'tolerance differs from world fact')
        check('interval-world-literal-units',interval['id'],interval_bindings)
    return dict(passed=not misses,misses=misses,checkedPages=len(record['pages']),bindingChecks=checks,
                adapter='v4 P world quantities, printed symbols and column roles; exact unit scales',
                printedReferenceAnchored=printed_reference is not None,worldHashAnchored=expected_world_hash is not None)
