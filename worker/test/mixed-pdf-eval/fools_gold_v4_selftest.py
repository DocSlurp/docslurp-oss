"""Focused negative tests for the immutable handoff and producer gates."""
import copy
from pathlib import Path
import unittest

from fools_gold_v4_common import *
from fools_gold_build_v4 import approve_stage
from fools_gold_v4_native import author
from fools_gold_v4_content import family_world
from fools_gold_v4_check import authoring_checks,evaluate_ast
from fools_gold_v4_transforms import plans_for_family

SPEC=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a4/spec-a4.json')


class V4Contracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec=load(SPEC);cls.family=cls.spec['dataset']['family_plan'][0]
        cls.world=freeze(family_world(cls.family),'worldHash')
        cls.authoring,cls.layout=author(cls.spec,cls.family,cls.world,file_hash(SPEC))

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
        plans=plans_for_family(self.spec,self.family,self.authoring,'0'*64)
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


if __name__=='__main__':unittest.main()
