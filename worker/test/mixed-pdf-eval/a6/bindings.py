"""Separate strict E binding sidecar; unchanged parent/support schemas."""
from decimal import Decimal
from contract import freeze
from semantics import actual_rows


def strict(properties):
    return dict(type='object',properties=properties,required=list(properties),additionalProperties=False)


STRING=dict(type='string')
STRINGS=dict(type='array',items=STRING)
REFERENCE=strict(dict(rowId=STRING,column=dict(type='integer',minimum=0,maximum=3)))
POPULATION=strict(dict(id=STRING,pageId=STRING,quantity=STRING,unit=STRING,window=STRING,
    role=dict(const='observation'),rowIds=STRINGS,valueRefs=dict(type='array',items=REFERENCE),
    inclusionPredicate=STRING))
CLAIM=strict(dict(id=STRING,blockId=STRING,populationId=STRING,
    kind=dict(enum=['count','empirical-extrema','reference-exceptions','reference-interval','subset']),
    literal=STRING,rowIds=STRINGS,quantity=STRING,unit=STRING,
    comparator=STRING,exactValues=STRINGS,rounding=STRING))
SCHEMA=strict(dict(schema=dict(const='a6-semantic-bindings@1'),worldHash=STRING,authoringHash=STRING,
    populations=dict(type='array',items=POPULATION),claims=dict(type='array',items=CLAIM),bindingHash=STRING))


def make_bindings(authoring,world):
    populations=[];claims=[]
    for page,wp in zip(authoring['pages'],world['pages']):
        rows=actual_rows(page,authoring['classId']=='E2')
        lookup={b['templateId']:b for b in page['blocks']}
        table=lookup['matrix.table'];pid=page['id'];popid=pid+'.population.main'
        rowids=[table['id']+f'.r{r}' for r,cells in rows]
        values=[Decimal(cells[1]['displayText']) for r,cells in rows]
        populations.append(dict(id=popid,pageId=pid,quantity='loaded mass',unit='mg',window=wp['window'],role='observation',
            rowIds=rowids,valueRefs=[dict(rowId=rid,column=1) for rid in rowids],inclusionPredicate='all main-table rows after the declared header tiers'))
        def add(suffix,block,kind,exact,comparator,subset=None):
            claims.append(dict(id=pid+'.claim.'+suffix,blockId=lookup[block]['id'],populationId=popid,kind=kind,
                literal=lookup[block]['displayText'],rowIds=rowids if subset is None else subset,quantity='loaded mass',unit='mg',
                comparator=comparator,exactValues=list(map(str,exact)),rounding='exact displayed Decimal; no extrema rounding'))
        add('body-count','body.1','count',[len(rows)],'cardinality equals spelled-out count')
        add('extrema','body.1','empirical-extrema',[min(values),max(values)],'minimum and maximum over every observation')
        add('quoted-count','discussion.excerpt','count',[len(rows)],'cardinality equals quoted spelled-out count')
        lo,hi=map(Decimal,wp['policy']['endpoints'])
        add('reference','math.constraint','reference-interval',[lo,hi,'0.2'],'independent inclusive endpoints; absolute mg instrument uncertainty does not expand limits')
        add('exceptions','body.2','reference-exceptions',[sum(not lo<=v<=hi for v in values)],'outside closed reference interval')
        if authoring['classId']=='E2':
            add('weighted-subset','body.2','subset',[1,3,6],'positions explicitly visible; full population remains six',
                [rowids[i] for i in (0,2,5)])
    return freeze(dict(schema='a6-semantic-bindings@1',worldHash=world['worldHash'],authoringHash=authoring['authoringHash'],
        populations=populations,claims=claims),'bindingHash')
