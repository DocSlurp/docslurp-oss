"""Focused negative tests for the immutable handoff and producer gates."""
import copy
from pathlib import Path
import unittest

from fools_gold_v4_common import *
from fools_gold_build_v4 import approve_stage
from fools_gold_v4_check import authoring_checks,evaluate_ast
from fools_gold_v4_semantic import semantic_checks,typed_value,unit
from decimal import Decimal, ROUND_HALF_UP

SPEC=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a4/spec-a4.json')
CORPUS=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a4/round-3')
_PROBE_RESULTS=None


def blocks(record,page=0):return {b['templateId']:b for b in record['pages'][page]['blocks']}


def synchronize(record):
    """In-memory probes remain schema-valid and canonically self-consistent.

    Same-length invented print edits update their existing glyph code points;
    no renderer is imported or called. This prevents a hash/projection failure
    from standing in for the semantic rejection the probes are testing.
    """
    for page in record['pages']:
        lookup={b['id']:b for b in page['blocks']}
        for b in page['blocks']:
            for glyph in b['glyphs']:glyph['text']=b['displayText'][glyph['logicalOffset']]
        texts=[lookup[bid]['displayText'] for bid in page['readingOrder']]
        page['sections']=texts;page['paragraphs']=texts.copy();page['expectedMarkdown']='\n\n'.join(texts)
    return freeze(record,'authoringHash')


def invented_control(fid):
    """Use only our own geometry; all numeric facts and tolerance are invented."""
    a=load(CORPUS/f'sources/{fid:04d}/authoring.json');w=load(CORPUS/f'sources/{fid:04d}/world.json')
    for page,facts in zip(a['pages'],w['pages']):
        lookup={b['templateId']:b for b in page['blocks']};old_lower=facts['lower'];old_upper=facts['upper']
        facts['lower']+=300;facts['upper']+=300
        facts['readings']=[x+300 for x in facts['readings']];facts['durations']=[x+37 for x in facts['durations']]
        facts['ratios']=[str((Decimal(x)/Decimal(y)).quantize(Decimal('.1'),rounding=ROUND_HALF_UP)) for x,y in zip(facts['readings'],facts['durations'])]
        facts['tolerance']='0.3'
        replacements={str(old_lower):str(facts['lower']),str(old_upper):str(facts['upper'])}
        def replace_numbers(text):
            return re.sub(r'\b[0-9]+\b',lambda m:replacements.get(m.group(),m.group()),text)
        facts['prose']=[replace_numbers(text) for text in facts['prose']]
        for name in ['body.1','body.2','discussion.excerpt','discussion.commentary']:lookup[name]['displayText']=replace_numbers(lookup[name]['displayText'])
        table=lookup['matrix.table'];cells={(c['row'],c['column']):c for c in table['cells']}
        for r in range(1,5):
            for c,val in [(1,str(facts['durations'][r-1])),(2,str(facts['readings'][r-1])),(3,f'{Decimal(facts["ratios"][r-1]):04.1f}')]:
                cells[(r,c)]['displayText']=val;cells[(r,c)]['value']=val
        table['displayText']='\n'.join(' | '.join(cells[(r,c)]['displayText'] for c in range(4)) for r in range(5))
        formula=lookup['math.rule']['formula'];q=formula['ast']['args'][0]['name'];num,den=[v['name'] for v in formula['ast']['args'][1]['args']]
        value=(Decimal(facts['readings'][0])/Decimal(facts['durations'][0])).quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
        for v in formula['variables']:
            v['valueDecimal']=str(value if v['symbol']==q else facts['readings'][0] if v['symbol']==num else facts['durations'][0])
        formula['valueDecimal']=str(value)
        interval=lookup['math.constraint'];f=interval['formula']
        interval['displayText']=replace_numbers(interval['displayText']).replace('0.4','0.3');f['display']=interval['displayText']
        f['latex']=replace_numbers(f['latex']).replace('0.4','0.3');f['absoluteTolerance']=.3;f['valueDecimal']='0.3'
        f['ast']['args'][0]['args'][0]['valueDecimal']=str(facts['lower']);f['ast']['args'][0]['args'][1]['valueDecimal']=str(facts['upper']);f['ast']['args'][1]['args'][0]['valueDecimal']='0.3'
    freeze(w,'worldHash');a['worldHash']=w['worldHash'];synchronize(a)
    reference={'pages':[{'id':p['id'],'blocks':copy.deepcopy(p['blocks'])} for p in a['pages']]}
    return a,w,reference


def semantic_probe_results():
    global _PROBE_RESULTS
    if _PROBE_RESULTS is not None:return _PROBE_RESULTS
    spec=load(SPEC);rows=[]
    for fid in [0,12]:
        control,world,reference=invented_control(fid);family=spec['dataset']['family_plan'][fid]
        def change_ast_lower(a,w):blocks(a)['math.constraint']['formula']['ast']['args'][0]['args'][0]['valueDecimal']=str(w['pages'][0]['lower']+7)
        def change_ast_upper(a,w):blocks(a)['math.constraint']['formula']['ast']['args'][0]['args'][1]['valueDecimal']=str(w['pages'][0]['upper']+7)
        def change_tolerance_ast(a,w):blocks(a)['math.constraint']['formula']['ast']['args'][1]['args'][0]['valueDecimal']='0.6'
        def change_tolerance_meta(a,w):blocks(a)['math.constraint']['formula']['absoluteTolerance']=.6
        def change_tolerance_value(a,w):blocks(a)['math.constraint']['formula']['valueDecimal']='0.6'
        def change_context_unit(a,w):
            f=blocks(a)['math.constraint']['formula'];f['constraints']=[v if not v.startswith('unit=') else 'unit=s' for v in f['constraints']]
        def change_interval_latex(a,w):blocks(a)['math.constraint']['formula']['latex']=blocks(a)['math.constraint']['formula']['latex'].replace('0.3','0.6')
        def table_unit(column,bad):
            def mutate(a,w):next(c for c in blocks(a)['matrix.table']['cells'] if (c['row'],c['column'])==(1,column))['unit']=bad
            return mutate
        def formula_unit(role,bad):
            def mutate(a,w):
                f=blocks(a)['math.rule']['formula'];symbol=f['ast']['args'][0]['name'] if role=='result' else f['ast']['args'][1]['args'][0 if role=='numerator' else 1]['name']
                next(v for v in f['variables'] if v['symbol']==symbol)['unit']=bad
            return mutate
        def swap_operands(a,w):
            f=blocks(a)['math.rule']['formula'];f['ast']['args'][1]['args'].reverse();vs={v['symbol']:v for v in f['variables']}
            left,right=[vs[v['name']]['valueDecimal'] for v in f['ast']['args'][1]['args']]
            value=str((Decimal(left)/Decimal(right)).quantize(Decimal('.000001'),rounding=ROUND_HALF_UP))
            f['valueDecimal']=vs[f['ast']['args'][0]['name']]['valueDecimal']=value
        def wrong_world_operand(a,w):
            f=blocks(a)['math.rule']['formula'];vs={v['symbol']:v for v in f['variables']};num,den=[x['name'] for x in f['ast']['args'][1]['args']];q=f['ast']['args'][0]['name']
            vs[num]['valueDecimal']=str(Decimal(vs[num]['valueDecimal'])+3)
            calculated=(Decimal(vs[num]['valueDecimal'])/Decimal(vs[den]['valueDecimal'])).quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
            vs[q]['valueDecimal']=f['valueDecimal']=str(calculated)
        def header_period(a,w):
            table=blocks(a)['matrix.table'];old='Rate/h' if fid==12 else 'Rate/s';new='Rate/s' if fid==12 else 'Rate/h'
            table['displayText']=table['displayText'].replace(old,new)
            c=next(c for c in table['cells'] if (c['row'],c['column'])==(0,3));c['displayText']=c['value']=new
        def swapped_header_roles(a,w):
            table=blocks(a)['matrix.table'];bypos={(c['row'],c['column']):c for c in table['cells']}
            for column,name in [(1,'Reading'),(2,'Time')]:bypos[(0,column)]['displayText']=bypos[(0,column)]['value']=name
            table['displayText']='\n'.join(' | '.join(bypos[(r,c)]['displayText'] for c in range(4)) for r in range(5))
        def wrong_rate_role(a,w):
            table=blocks(a)['matrix.table'];table['displayText']=table['displayText'].replace('Rate/','Time/')
            c=next(c for c in table['cells'] if (c['row'],c['column'])==(0,3));c['displayText']=c['value']=c['displayText'].replace('Rate/','Time/')
        def wrong_cell_value(a,w):next(c for c in blocks(a)['matrix.table']['cells'] if (c['row'],c['column'])==(1,2))['value']='911'
        def wrong_world_fact(a,w):w['pages'][0]['lower']+=1
        def wrong_world_identity(a,w):w['familyId']=fid+1
        def wrong_world_seed(a,w):w['seed']+=1
        def duplicate_variable(a,w):blocks(a)['math.rule']['formula']['variables'].append(copy.deepcopy(blocks(a)['math.rule']['formula']['variables'][0]))
        def huge_numeric_tolerance(a,w):blocks(a)['math.rule']['formula']['absoluteTolerance']=10.0
        def coherent_tolerance(a,w):
            f=blocks(a)['math.constraint']['formula'];w['pages'][0]['tolerance']='0.6'
            blocks(a)['math.constraint']['displayText']=f['display']=f['display'].replace('0.3','0.6')
            f['latex']=f['latex'].replace('0.3','0.6');f['ast']['args'][1]['args'][0]['valueDecimal']='0.6';f['absoluteTolerance']=.6;f['valueDecimal']='0.6'
        def coherent_wrong_rate_basis(a,w):
            # Same dimensions, different scale, no conversion of printed data.
            new='s' if fid==12 else 'h';header_period(a,w)
            for c in blocks(a)['matrix.table']['cells']:
                if c['row'] and c['column']==1:c['unit']=new
                if c['row'] and c['column']==3:c['unit']=w['unit']+'/'+new
            f=blocks(a)['math.rule']['formula'];q=f['ast']['args'][0]['name'];den=f['ast']['args'][1]['args'][1]['name']
            for v in f['variables']:
                if v['symbol']==den:v['unit']=new
                elif v['symbol']==q:v['unit']=w['unit']+'/'+new
        def alias_units(a,w):
            for c in blocks(a)['matrix.table']['cells']:
                if c['row'] and c['column']==2:c['unit']='pieces' if fid==12 else 'grams'
        def alias_formula_units(a,w):
            f=blocks(a)['math.rule']['formula'];q=f['ast']['args'][0]['name'];num,den=[v['name'] for v in f['ast']['args'][1]['args']]
            reading='pieces' if fid==12 else 'grams';duration='hours' if fid==12 else 'seconds'
            for v in f['variables']:v['unit']=reading+'/'+duration if v['symbol']==q else reading if v['symbol']==num else duration
        def printed_tolerance_unit(a,w):
            b=blocks(a)['math.constraint'];old='pcs' if fid==12 else 'g';new='sec' if fid==12 else 's'
            self_text=b['displayText'];head,tail=self_text.rsplit(old,1);b['displayText']=b['formula']['display']=head+new+tail
        def printed_interval_unit(a,w):
            b=blocks(a)['math.constraint'];b['displayText']=b['formula']['display']=b['displayText'].replace('] pcs;','] sec;').replace('] grams;','] hours;')
        probes=[
            ('valid_invented',None,True,None),('valid_unit_alias',alias_units,True,None),
            ('valid_formula_unit_aliases',alias_formula_units,True,None),
            ('ast_lower_endpoint',change_ast_lower,False,'semantic-interval-world-literal-units'),
            ('ast_upper_endpoint',change_ast_upper,False,'semantic-interval-world-literal-units'),
            ('ast_tolerance',change_tolerance_ast,False,'semantic-interval-world-literal-units'),
            ('tolerance_metadata',change_tolerance_meta,False,'semantic-interval-world-literal-units'),
            ('tolerance_value',change_tolerance_value,False,'semantic-interval-world-literal-units'),
            ('tolerance_unit_context',change_context_unit,False,'semantic-interval-world-literal-units'),
            ('printed_tolerance_unit',printed_tolerance_unit,False,'semantic-interval-world-literal-units'),
            ('printed_interval_unit',printed_interval_unit,False,'semantic-interval-world-literal-units'),
            ('interval_latex',change_interval_latex,False,'semantic-interval-world-literal-units'),
            ('table_duration_scale',table_unit(1,'s' if fid==12 else 'h'),False,'semantic-table-world-units'),
            ('table_reading_dimension',table_unit(2,'s'),False,'semantic-table-world-units'),
            ('table_reading_scale',table_unit(2,'kg'),False,'semantic-table-world-units'),
            ('table_rate_dimension',table_unit(3,'g'),False,'semantic-table-world-units'),
            ('table_rate_scale',table_unit(3,'unit/s' if fid==12 else 'g/h'),False,'semantic-table-world-units'),
            ('table_unknown_unit',table_unit(2,'unknown-unit'),False,'semantic-table-world-units'),
            ('table_typed_value',wrong_cell_value,False,'semantic-table-world-units'),
            ('formula_numerator_unit',formula_unit('numerator','s'),False,'semantic-formula-world-literal-units'),
            ('formula_denominator_scale',formula_unit('denominator','s' if fid==12 else 'h'),False,'semantic-formula-world-literal-units'),
            ('formula_result_unit',formula_unit('result','g'),False,'semantic-formula-world-literal-units'),
            ('printed_ast_operand_order',swap_operands,False,'semantic-formula-world-literal-units'),
            ('computed_but_wrong_world_operand',wrong_world_operand,False,'semantic-formula-world-literal-units'),
            ('printed_rate_header',header_period,False,'semantic-table-world-units'),
            ('swapped_header_quantity_roles',swapped_header_roles,False,'semantic-table-world-units'),
            ('wrong_rate_quantity_role',wrong_rate_role,False,'semantic-table-world-units'),
            ('coherent_wrong_rate_basis',coherent_wrong_rate_basis,False,'semantic-table-world-units'),
            ('world_endpoint_rehashed',wrong_world_fact,False,'semantic-interval-world-literal-units'),
            ('wrong_world_family_rehashed',wrong_world_identity,False,'semantic-world-reference'),
            ('wrong_world_seed_rehashed',wrong_world_seed,False,'semantic-world-reference'),
            ('duplicate_variable',duplicate_variable,False,'semantic-formula-world-literal-units'),
            ('inflated_computational_tolerance',huge_numeric_tolerance,False,'semantic-formula-world-literal-units'),
            ('coherent_tolerance_vs_frozen_print',coherent_tolerance,False,'semantic-printed-reference')]
        for name,mutate,expected,required_kind in probes:
            a=copy.deepcopy(control);w=copy.deepcopy(world)
            if mutate:mutate(a,w)
            freeze(w,'worldHash');a['worldHash']=w['worldHash'];synchronize(a)
            validate_schema(a,spec['immutable_records']['schemas']['authoring'])
            result=semantic_checks(a,w,family,reference,tolerance_range=[.1,.9])
            kinds={m['kind'] for m in result['misses']}
            rows.append(dict(id=f'invented-{fid}-{name}',expectedPassed=expected,actualPassed=result['passed'],schemaValid=True,authoringSelfHashValid=record_hash(a,'authoringHash')==a['authoringHash'],worldSelfHashValid=record_hash(w,'worldHash')==w['worldHash'],authoringHash=a['authoringHash'],worldHash=w['worldHash'],requiredSemanticFailure=required_kind,requiredSemanticFailureObserved=required_kind in kinds if required_kind else True,misses=result['misses']))
    _PROBE_RESULTS=dict(schema='mixed-pdf-semantic-probes@1',cases=rows,validControls=sum(r['expectedPassed'] for r in rows),negativeProbes=sum(not r['expectedPassed'] for r in rows),allExpectedOutcomes=all(r['expectedPassed']==r['actualPassed'] and r['requiredSemanticFailureObserved'] for r in rows))
    return _PROBE_RESULTS


class V4Contracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec=load(SPEC);cls.family=cls.spec['dataset']['family_plan'][0]
        cls.world=load(CORPUS/'sources/0000/world.json')
        cls.authoring=load(CORPUS/'sources/0000/authoring.json')

    def test_forbid_ungated_expansion(self):
        for stage in ['factorial-pilot','full']:
            with self.assertRaises(ValueError):approve_stage(stage,'a'*64,None,None)
            with self.assertRaises(ValueError):approve_stage(stage,'a'*64,None,'b'*64)
            with self.assertRaises(ValueError):approve_stage(stage,'a'*64,None,'a'*64)

    def test_strict_schema_rejects_unknown_fields(self):
        a=copy.deepcopy(self.authoring);a['silentWaiver']=True
        with self.assertRaises(ValueError):validate_schema(a,self.spec['immutable_records']['schemas']['authoring'])

    def test_cross_record_rejects_bad_projection(self):
        a=copy.deepcopy(self.authoring);a['pages'][0]['sections'].append('inferred text')
        self.assertFalse(authoring_checks(self.spec,self.family,a,self.world)['passed'])

    def test_mutation_changes_frozen_hash(self):
        a=copy.deepcopy(self.authoring);a['pages'][0]['blocks'][0]['displayText']+=' extra'
        self.assertNotEqual(record_hash(a,'authoringHash'),self.authoring['authoringHash'])

    def test_nonzero_denominator(self):
        with self.assertRaises(ValueError):evaluate_ast({'op':'divide','args':[{'op':'constant','valueDecimal':'1'},{'op':'constant','valueDecimal':'0'}]}, {})

    def test_nested_hard_selection_and_exact_transform_cycles(self):
        plans=[(load(CORPUS/f'plans/0000/{h}.json'),load(CORPUS/f'plans/0000/{h}-exclusions.json')) for h in [0,20,40,60,80,100]]
        for plan,exclusions in plans:
            self.assertEqual(plan['selectedHardPageIds'],plan['hardPageRank'][:plan['hardPercent']//10])
            self.assertEqual(len(plan['selectedHardPageIds']),plan['hardPercent']//10)
            self.assertEqual(plan['pages'][8]['rotationDegrees'],90)
            self.assertEqual(len(exclusions['items']),2)
            for pp in plan['pages']:
                for op in pp['operations']:
                    if op['kind']=='hard-scan':
                        index=(int(pp['pageId'].split('.p')[-1])-1)%5
                        self.assertEqual(op['dpi'],[85,95,105,115,125][index])
                        self.assertEqual(op['jpegQuality'],[54,62,70,78,86][index])

    def test_canonical_nfc_and_own_hash_only(self):
        self.assertEqual(canonical({'a':'e\u0301'}),canonical({'a':'é'}))
        a=freeze({'value':1,'otherHash':'x'},'ownHash')
        self.assertNotEqual(record_hash({**a,'otherHash':'y'},'ownHash'),a['ownHash'])

    def test_all_actual_prototype_authoring_records(self):
        for fid in [0,6,12]:
            with self.subTest(family=fid):
                a=load(CORPUS/f'sources/{fid:04d}/authoring.json');w=load(CORPUS/f'sources/{fid:04d}/world.json');ref=load(CORPUS/f'sources/{fid:04d}/source-layout.json')
                result=authoring_checks(self.spec,self.spec['dataset']['family_plan'][fid],a,w,ref,w['worldHash'])
                self.assertTrue(result['passed'],result['misses'])

    def test_rehashed_schema_valid_semantic_probes(self):
        report=semantic_probe_results()
        for case in report['cases']:
            with self.subTest(probe=case['id']):
                self.assertTrue(case['schemaValid'] and case['authoringSelfHashValid'] and case['worldSelfHashValid'])
                self.assertEqual(case['actualPassed'],case['expectedPassed'],case['misses'])
                self.assertTrue(case['requiredSemanticFailureObserved'],case['misses'])

    def test_dimensional_algebra_rejects_unlike_addends(self):
        ast={'op':'add','args':[{'op':'symbol','name':'load'},{'op':'symbol','name':'duration'}]}
        with self.assertRaises(ValueError):typed_value(ast,{'load':dict(valueDecimal='7',unit='g'),'duration':dict(valueDecimal='7',unit='s')})

    def test_rate_unit_scale_is_not_dimensionless_or_interchangeable(self):
        self.assertNotEqual(unit('g/s'),unit('g/h'))
        self.assertNotEqual(unit('unit/h'),unit('1'))
        self.assertEqual(unit('grams/seconds'),unit('g/s'))


if __name__=='__main__':
    import argparse,sys
    parser=argparse.ArgumentParser(add_help=False);parser.add_argument('--probe-report',type=Path)
    options,rest=parser.parse_known_args()
    program=unittest.main(argv=[sys.argv[0]]+rest,exit=False)
    if options.probe_report:save(options.probe_report,semantic_probe_results())
    raise SystemExit(0 if program.result.wasSuccessful() else 1)
