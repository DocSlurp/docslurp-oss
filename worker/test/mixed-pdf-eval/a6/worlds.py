"""Fresh E worlds, finalized cells first. No prior fixture vocabulary or values."""
from __future__ import annotations
from decimal import Decimal, ROUND_HALF_UP
import random
from contract import family_plan, freeze, digest

DOMAINS = [
    ('powder reclaim', 'cyclone', 'porous feed', 'pressure equalization', 'retain the screened fraction'),
    ('optical settling', 'photometer', 'clouded cuvette', 'surface reflection', 'clean the reference window'),
    ('adhesive conditioning', 'mixing head', 'viscous resin', 'thermal relaxation', 'extend the sheltered dwell'),
    ('bearing service', 'grease port', 'abraded sleeve', 'capillary migration', 'replace the scored bushing'),
    ('buffer preparation', 'dosing pump', 'diluted reagent', 'ionic exchange', 'isolate the return circuit'),
    ('filter recovery', 'membrane', 'retained slurry', 'pore obstruction', 'flush the permeate channel'),
    ('seal inspection', 'pressure chamber', 'creased gasket', 'elastic recovery', 'reset the seating collar'),
    ('granule transport', 'feed screw', 'agglomerated powder', 'frictional heating', 'reduce the transfer pulse'),
    ('thermal treatment', 'holding rack', 'laminated coupon', 'conductive transfer', 'inspect the insulated carrier'),
    ('electrode cleaning', 'rinse manifold', 'oxidized contact', 'electrolytic removal', 'renew the cleaning solution'),
    ('viscosity tracking', 'rotational spindle', 'settled suspension', 'shear thinning', 'repeat the gentle inversion'),
    ('humidity buffering', 'desiccant tray', 'saturated bead', 'moisture diffusion', 'restore the sealed enclosure'),
    ('pigment dispersion', 'milling loop', 'coarse pigment', 'particle attrition', 'check the recirculation valve'),
    ('nozzle maintenance', 'orifice plate', 'deposited binder', 'jet contraction', 'replace the blocked restrictor'),
    ('ceramic finishing', 'lapping fixture', 'fractured grain', 'abrasive entrainment', 'segregate the finishing medium'),
]
PURPOSES = ['observation', 'mechanism', 'qualification', 'decision', 'exception',
            'counterexample', 'handover', 'containment', 'comparison', 'closure']


def decimal(value): return format(Decimal(value), 'f')


def make_world(family):
    fid=family['familyId']; rng=random.Random(family['worldSeed'])
    domain=DOMAINS[[f['familyId'] for f in family_plan()].index(fid)]
    pages=[]
    for p in range(1,11):
        n=6 if family['classId']=='E2' else 4
        rows=[]
        base=Decimal(140+fid*7+p*3)
        for j in range(n):
            # All six E2 rows matter; the last two cannot be an unnoticed prefix.
            load=base+Decimal([7,23,11,31,2,43][j])+Decimal(rng.randint(1,9))/10
            if family['classId']!='E2': load=Decimal(round(load))
            elapsed=Decimal(101+rng.randrange(1,35))
            if family['classId']=='E2':
                load+=Decimal(rng.randint(1,9))/100
                elapsed+=Decimal(rng.randint(11,99))/100
            derived=(load/elapsed*10).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)
            if family['classId']=='E2':
                cells=[f'RM{fid:02d}{p:02d}{j+1:02d}', decimal(load), decimal(elapsed), f'{derived} U']
            else:
                assert 10<=derived<100
                cells=[f'{chr(65+fid)}{p:02d}{j+1:02d}',decimal(load),decimal(elapsed),f'{derived:04.1f}']
            rows.append(dict(id=f'f{fid:04d}.p{p:02d}.matrix.table.r{j+(2 if n==6 else 1)}',
                cells=cells, quantity='loaded mass', unit='mg', role='observation'))
        loads=[Decimal(r['cells'][1]) for r in rows]
        # Independently selected policy values, not empirical endpoints.
        policy=[decimal(base+Decimal(5)),decimal(base+Decimal(30))]
        series=[]
        for s in range(2):
            y=[decimal((base/10+Decimal(i)*Decimal('.7')+Decimal(rng.randint(-6,6))/10+Decimal(s)*Decimal('2.3')).quantize(Decimal('.1'))) for i in range(8)]
            series.append(dict(name=['Inlet','Return'][s], x=[str(i+1) for i in range(8)], y=y, unitX='s', unitY='mg'))
        pages.append(dict(number=p,purpose=PURPOSES[p-1], window=f'cycle {p}', observations=rows,
            calibration=dict(g=decimal(Decimal(1)+Decimal(fid+p)/1000),h=decimal(-Decimal(fid+p)/100),
                u=decimal(base+19),powerGain=decimal(Decimal(2)+Decimal(fid+p)/100),exponent='2',
                weights=[str(2+fid%3),str(3+p%2),str(4+(fid+p)%3)]),
            policy=dict(kind='reference_interval',quantity='loaded mass',unit='mg',endpoints=policy,
                inclusive=True,tolerance=dict(value='0.2',unit='mg',kind='absolute',purpose='instrument uncertainty; does not widen the policy interval')),
            formulaSelection=[0,2,n-1],chart=series))
    return freeze(dict(schema='a6-world@1', familyId=fid, split='train',
        domain=dict(zip(['subject','component','material','mechanism','action'],domain)),
        quantities=dict(load='mg',elapsed='s',derived='U = 0.1 mg/s'),pages=pages), 'worldHash')
