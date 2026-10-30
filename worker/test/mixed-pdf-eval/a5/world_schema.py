"""Strict source-blind world contract, independent of PDF production."""
from decimal import Decimal
from jsonschema import Draft202012Validator
from support import digest

DECIMAL={'type':'string','pattern':r'^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'}
def object_schema(fields):
    return dict(type='object',properties=fields,required=list(fields),additionalProperties=False)
def array(items,n):return dict(type='array',items=items,minItems=n,maxItems=n)
INT=dict(type='integer',minimum=101,maximum=989)
PAGE=object_schema(dict(number=dict(type='integer',minimum=1,maximum=10),lower=INT,upper=INT,
    readings=array(INT,6),durations=array(INT,6),purpose=dict(enum=['observation','mechanism','qualification','exception','decision','counterexample','reconciliation','handover']),
    weights=array(DECIMAL,3),gain=DECIMAL,offset=DECIMAL,voltage=DECIMAL,reference=DECIMAL,exponent=DECIMAL,chartSeries=array(array(DECIMAL,8),2)))
WORLD=object_schema(dict(schema=dict(const='attempt5-world@1'),familyId=dict(type='integer',minimum=1,maximum=17),seed=dict(type='integer'),unit=dict(const='g'),durationUnit=dict(const='s'),part=dict(type='string',minLength=1),title=dict(type='string',minLength=24,maxLength=64),role=dict(type='string'),date=dict(type='string',pattern=r'^2026-04-[0-9]{2}$'),pages=array(PAGE,10),worldHash=dict(type='string',pattern='^[a-f0-9]{64}$')))


def validate_world(world,family):
    Draft202012Validator(WORLD).validate(world)
    assert world['worldHash']==digest({k:v for k,v in world.items() if k!='worldHash'})
    assert (world['familyId'],world['seed'])==(family['familyId'],family['worldSeed'])
    assert [p['number'] for p in world['pages']]==list(range(1,11))
    for p in world['pages']:
        assert p['lower']==min(p['readings'][:4]) and p['upper']==max(p['readings'][:4])
        assert len(set(p['readings']))==6
        assert all(Decimal(v)>0 for v in p['weights']+[p['reference'],p['exponent']])
        assert Decimal('.1')<=Decimal(p['voltage'])<=100
        assert all(0<=Decimal(v)<=100 for series in p['chartSeries'] for v in series)
