"""Negative semantic/schema cases for the clean authored contracts."""
import copy
import json
import unittest
from jsonschema import ValidationError
from support import CLEAN,freeze
from content import new_world
from author import resolve
from check import semantic_checks
from world_schema import validate_world


class ContractNegatives(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec=json.loads((CLEAN/'spec-a5.json').read_text());cls.family=cls.spec['dataset']['family_plan'][7]
        cls.world=new_world(cls.family);cls.auth,cls.plans,cls.resolved,misses=resolve(cls.spec,cls.family,cls.world,{'producer':'constructed-negative-tests'})
        assert not misses

    def evaluate_mutation(self,change):
        w,a,p,r=copy.deepcopy((self.world,self.auth,self.plans,self.resolved));change(w,a,p,r)
        try:return semantic_checks(self.spec,self.family,w,a,p,r)['passed']
        except (AssertionError,ValueError,KeyError,TypeError):return False

    def test_baseline(self):
        self.assertTrue(semantic_checks(self.spec,self.family,self.world,self.auth,self.plans,self.resolved)['passed'])

    def test_unknown_world_key_rejected(self):
        w=copy.deepcopy(self.world);w['unknown']='extra';freeze(w,'worldHash')
        with self.assertRaises(ValidationError):validate_world(w,self.family)

    def test_world_hash_tamper(self):
        self.assertFalse(self.evaluate_mutation(lambda w,a,p,r:w['pages'][0]['readings'].__setitem__(0,999)))

    def test_gold_projection_tamper(self):
        self.assertFalse(self.evaluate_mutation(lambda w,a,p,r:a['pages'][0]['sections'].__setitem__(0,'Changed heading')))

    def test_cell_value_tamper_even_with_new_author_hash(self):
        def change(w,a,p,r):
            b=next(b for b in a['pages'][0]['blocks'] if b['templateId']=='matrix.table');b['cells'][5]['value']='997';freeze(a,'authoringHash')
        self.assertFalse(self.evaluate_mutation(change))

    def test_wrong_operand_units(self):
        def change(w,a,p,r):
            b=next(b for b in a['pages'][0]['blocks'] if b['templateId']=='math.rule');b['formula']['variables'][0]['unit']='s';freeze(a,'authoringHash')
        self.assertFalse(self.evaluate_mutation(change))

    def test_wrong_formula_world_operand(self):
        def change(w,a,p,r):
            b=next(b for b in a['pages'][0]['blocks'] if b['templateId']=='math.rule');b['formula']['variables'][0]['valueDecimal']='997';freeze(a,'authoringHash')
        self.assertFalse(self.evaluate_mutation(change))

    def test_missing_chart_point(self):
        def change(w,a,p,r):
            b=next(b for b in a['pages'][0]['blocks'] if b['chart']);b['chart']['data'][0]['yDecimals'].pop();freeze(a,'authoringHash')
        self.assertFalse(self.evaluate_mutation(change))

    def test_missing_separator(self):
        def change(w,a,p,r):
            b=next(b for b in a['pages'][0]['blocks'] if b['templateId']=='matrix.table');b['displayText']=b['displayText'].replace('|','',1);freeze(a,'authoringHash')
        self.assertFalse(self.evaluate_mutation(change))

    def test_duplicate_paint_unit(self):
        def change(w,a,p,r):p[0]['paintOrder'].append(p[0]['paintOrder'][0]);freeze(p[0],'planHash')
        self.assertFalse(self.evaluate_mutation(change))

    def test_forged_support(self):
        def change(w,a,p,r):
            g=next(g for leaf in p[0]['leaves'] for g in leaf['glyphs'] if g['expectedInkPt']);g['expectedInkPt'][0]+=.2;freeze(p[0],'planHash')
        self.assertFalse(self.evaluate_mutation(change))


if __name__=='__main__':unittest.main()
