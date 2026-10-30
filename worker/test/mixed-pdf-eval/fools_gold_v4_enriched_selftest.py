"""Invented E controls and rehashed, schema-valid semantic mutations.

These in-memory test worlds reuse only our own prototype prose geometry. They
are not corpus candidates and do not claim diversity/layout acceptance.
"""
import argparse
import copy
from pathlib import Path
import unittest
from fools_gold_v4_common import *
from fools_gold_v4_semantic import semantic_checks
from fools_gold_v4_selftest import synchronize

SPEC=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a4/spec-a4.json')
CORPUS=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a4/round-3')


def invented_controls():
    from fools_gold_v4_content import family_world
    from fools_gold_v4_enriched import E1_CAUSAL,E1_ACTION
    from fools_gold_v4_native import author
    spec=load(SPEC);prototype=load(CORPUS/'sources/0000/world.json');controls=[]
    for fid in [1,2,3,4,5]:
        family=spec['dataset']['family_plan'][fid];world=family_world(family)
        for i,page in enumerate(world['pages']):
            # Distinct numeric worlds, not copied delivered prototype values.
            page['readings']=[v+73 for v in page['readings']];page['lower']=page['readings'][0];page['upper']=page['readings'][-1]
            from decimal import Decimal,ROUND_HALF_UP
            page['ratios']=[str((Decimal(a)/Decimal(b)).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)) for a,b in zip(page['readings'],page['durations'])]
            for j in range(3):page['formulaFacts'][f'x_{j+1}']=str(Decimal(page['readings'][j])+(Decimal(j)/10 if family['classId']=='E2' else Decimal(0)))
            source=prototype['pages'][i];page['prose']=copy.deepcopy(source['prose'])
            import re
            replacements={str(source['lower']):str(page['lower']),str(source['upper']):str(page['upper'])}
            page['prose']=[re.sub(r'\b[0-9]+\b',lambda m:replacements.get(m.group(),m.group()),text) for text in page['prose']]
            page['finalProse']=copy.deepcopy(page['prose'])
            if family['classId']=='E1':page['finalProse'][:2]=[page['prose'][0]+' '+E1_CAUSAL[i],page['prose'][1]+' '+E1_ACTION[i]]
        freeze(world,'worldHash');authored,reference=author(spec,family,world,file_hash(SPEC))
        controls.append(dict(family=family,world=world,authoring=authored,reference=reference))
    return controls


def probes(controls):
    spec=load(SPEC);rows=[]
    def run_case(control,name,mutate=None):
        a=copy.deepcopy(control['authoring']);w=copy.deepcopy(control['world']);family=control['family'];page=a['pages'][0];b={b['templateId']:b for b in page['blocks']}
        if mutate:mutate(a,w,b)
        freeze(w,'worldHash');a['worldHash']=w['worldHash'];synchronize(a)
        validate_schema(a,spec['immutable_records']['schemas']['authoring'])
        # No printed reference is supplied for negative probes: rejection must
        # come from world/printed/AST/units rather than a blanket print diff.
        result=semantic_checks(a,w,family,tolerance_range=[.1,.9]);expected=mutate is None
        print(f'{family["classId"]}/{name}: expected={expected} actual={result["passed"]}',flush=True)
        rows.append(dict(id=f'{family["classId"]}/{name}',schemaValid=True,authoringSelfHashValid=record_hash(a,'authoringHash')==a['authoringHash'],worldSelfHashValid=record_hash(w,'worldHash')==w['worldHash'],expectedPassed=expected,actualPassed=result['passed'],misses=result['misses']))
    for c in controls:
        cid=c['family']['classId'];run_case(c,'valid-invented-control')
        def varunit(a,w,b):b['math.rule']['formula']['variables'][0]['unit']='kg'
        def varvalue(a,w,b):b['math.rule']['formula']['variables'][0]['valueDecimal']='999'
        def badast(a,w,b):b['math.rule']['formula']['ast']['args'][1]['op']='subtract' if b['math.rule']['formula']['ast']['args'][1]['op']=='add' else 'add'
        def badlatex(a,w,b):b['math.rule']['formula']['latex']=b['math.rule']['formula']['latex'].replace('q =','z =')
        def badliteral(a,w,b):b['math.rule']['displayText']=b['math.rule']['displayText'].replace('q =','z =');b['math.rule']['formula']['display']=b['math.rule']['displayText']
        def endpoint(a,w,b):b['math.constraint']['formula']['ast']['args'][0]['args'][0]['valueDecimal']='999'
        def rateunit(a,w,b):next(v for v in b['matrix.table']['cells'] if v['row']==(2 if cid=='E2' else 1) and v['column']==3)['unit']='g/h'
        def headunit(a,w,b):b['matrix.table']['cells'][1]['unit']='s'
        for name,fn in [('operand-unit',varunit),('operand-world-value',varvalue),('ast-recipe',badast),('latex-operand',badlatex),('printed-operand',badliteral),('interval-endpoint',endpoint),('rate-scale',rateunit),('header-as-data',headunit)]:run_case(c,name,fn)
        if cid=='E1':
            run_case(c,'causal-prose-world',lambda a,w,b:w['pages'][0]['finalProse'].__setitem__(0,'A changed causal claim.'))
        if cid=='E2':
            run_case(c,'merged-span',lambda a,w,b:b['matrix.table']['cells'][1].__setitem__('columnSpan',1))
            run_case(c,'second-header-data-unit',lambda a,w,b:next(v for v in b['matrix.table']['cells'] if v['row']==1 and v['column']==2).__setitem__('unit','g'))
            run_case(c,'sixth-row-typed-value',lambda a,w,b:b['matrix.table']['cells'][-2].__setitem__('value','999.99'))
            def coherent_sample(a,w,b):
                from fools_gold_v4_check import evaluate_ast
                formula=b['math.rule']['formula'];w['pages'][0]['formulaFacts']['x_2']='999'
                next(v for v in formula['variables'] if v['symbol']=='x_2')['valueDecimal']='999'
                values={v['symbol']:v['valueDecimal'] for v in formula['variables']}
                result=evaluate_ast(formula['ast']['args'][1],values).quantize(__import__('decimal').Decimal('.000001'),rounding=__import__('decimal').ROUND_HALF_UP)
                formula['valueDecimal']=str(result);next(v for v in formula['variables'] if v['symbol']=='q')['valueDecimal']=str(result)
            run_case(c,'coherent-weighted-sample-vs-printed-row',coherent_sample)
            run_case(c,'weight-dimension',lambda a,w,b:next(v for v in b['math.rule']['formula']['variables'] if v['symbol']=='w_1').__setitem__('unit','g'))
            run_case(c,'weighted-world-value',lambda a,w,b:w['pages'][0]['formulaFacts'].__setitem__('w_3','9'))
        if cid=='E3':
            run_case(c,'series-y-value',lambda a,w,b:b['chart']['chart']['data'][0]['yDecimals'].__setitem__(0,'99'))
            run_case(c,'series-units',lambda a,w,b:b['chart']['chart']['data'][0].__setitem__('unitY','g'))
            run_case(c,'series-legend-name',lambda a,w,b:b['chart']['chart']['data'][1].__setitem__('name','Renamed'))
            run_case(c,'tick-value',lambda a,w,b:b['chart']['chart']['ticks'][0].__setitem__('valueDecimal','7'))
            run_case(c,'tick-label',lambda a,w,b:b['chart']['chart']['ticks'][0].__setitem__('displayText','7'))
            run_case(c,'axis-unit-label',lambda a,w,b:b['chart']['chart']['axisTitles'].__setitem__(1,'Response (g)'))
            run_case(c,'legend-index',lambda a,w,b:b['chart']['chart']['legend'][0].__setitem__('seriesIndex',1))
            run_case(c,'tick-outside-chart',lambda a,w,b:b['chart']['chart']['ticks'][0].__setitem__('bboxPt',[1,1,2,2]))
            run_case(c,'caption-binding',lambda a,w,b:b['chart']['chart'].__setitem__('captionBlockId',b['body.1']['id']))
        if cid=='E4':
            run_case(c,'nested-table-value',lambda a,w,b:b['discussion.mini-table']['cells'][4].__setitem__('value','999'))
            run_case(c,'nested-table-unit',lambda a,w,b:b['discussion.mini-table']['cells'][4].__setitem__('unit','s'))
            run_case(c,'nested-table-label-unit',lambda a,w,b:b['discussion.mini-table']['cells'][5].__setitem__('unit','g'))
            run_case(c,'nested-table-span',lambda a,w,b:b['discussion.mini-table']['cells'][4].__setitem__('rowSpan',2))
            run_case(c,'nested-formula-order',lambda a,w,b:b['discussion.mini-math']['formula']['ast']['args'][1]['args'].reverse())
            run_case(c,'nested-formula-unit',lambda a,w,b:b['discussion.mini-math']['formula']['variables'][0].__setitem__('unit','s'))
            run_case(c,'screenshot-frame-containment',lambda a,w,b:b['discussion.frame'].__setitem__('bboxPt',[32,469,580,550]))
        if cid=='E5':
            def coherent_visibility(a,w,b):
                row=b['overlay.row.2'];row['visible']=True
                for glyph in row['glyphs']:glyph['visible']=True
                a['pages'][0]['readingOrder'].append(row['id'])
                a['pages'][0]['blockIdsForSections'].append(row['id']);a['pages'][0]['blockIdsForParagraphs'].append(row['id'])
            run_case(c,'coherent-hidden-row-visible',coherent_visibility)
            run_case(c,'hidden-row-visible',lambda a,w,b:b['overlay.row.2'].__setitem__('visible',True))
            run_case(c,'visible-row-hidden',lambda a,w,b:b['overlay.row.1'].__setitem__('visible',False))
            run_case(c,'cover-z-order',lambda a,w,b:b['overlay.cover'].__setitem__('zOrder',0))
            run_case(c,'cover-misses-glyph',lambda a,w,b:b['overlay.cover'].__setitem__('bboxPt',[35,85,40,90]))
            run_case(c,'card-containment',lambda a,w,b:b['overlay.card'].__setitem__('bboxPt',[35,85,40,90]))
            run_case(c,'row-world-text',lambda a,w,b:w['pages'][0]['overlayRows'].__setitem__(0,'Different retained reference'))
    return dict(schema='mixed-pdf-enriched-semantic-probes@1',cases=rows,validControls=sum(r['expectedPassed'] for r in rows),negativeProbes=sum(not r['expectedPassed'] for r in rows),allExpectedOutcomes=all(r['expectedPassed']==r['actualPassed'] for r in rows))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--report',type=Path,required=True);args=p.parse_args()
    result=probes(invented_controls());save(args.report,result)
    print({k:v for k,v in result.items() if k!='cases'})
    for row in result['cases']:
        if row['actualPassed']!=row['expectedPassed']:print(row['id'],row['misses'][:2])
    raise SystemExit(0 if result['allExpectedOutcomes'] else 1)
