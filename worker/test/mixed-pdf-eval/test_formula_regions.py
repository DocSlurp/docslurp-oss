import copy
import unittest

from spatial_evidence import formula_region_diagnostics


class FormulaRegionTests(unittest.TestCase):
    def evidence(self, formula='q = a / b', quotation='q = a / b'):
        words=[]
        for top,text in [(.1,formula),(.7,quotation)]:
            for column,value in enumerate(text.split()):
                left=.1+column*.06
                words.append(dict(text=value,order=len(words),bboxNormalized=[left,top,left+.04,top+.04],clippedByDisplay=False))
        return dict(schema='mixed-pdf-word-evidence@1',normalizedBasis='final-display-fractions',
                    normalizationVerified=False,words=words)

    def regions(self):
        return [dict(blockId='rule',text='q = a / b',bboxNormalized=[.09,.09,.65,.15])]

    def test_correct_literal_is_diagnostic_only(self):
        result=formula_region_diagnostics(self.regions(),self.evidence())
        self.assertEqual(result['literalRegionRecall'],1)
        self.assertFalse(result['acceptanceEvidenceComplete'])
        self.assertEqual(result['regions'][0]['wordOrders'],[0,1,2,3,4])
        # Extractor word segmentation can change without changing the expression.
        self.assertEqual(formula_region_diagnostics(self.regions(),self.evidence('q=a/b'))['literalRegionRecall'],1)

    def test_quote_elsewhere_cannot_repair_corruption_or_deletion(self):
        for changed in ['q = A / b','q = a / b + c','q = a * b','']:
            with self.subTest(changed=changed):
                result=formula_region_diagnostics(self.regions(),self.evidence(changed))
                self.assertEqual(result['literalRegionRecall'],0)
        evidence=self.evidence('q = A / b')
        for word in evidence['words'][5:]:word['text']=word['text'].upper()
        self.assertEqual(formula_region_diagnostics(self.regions(),evidence)['literalRegionRecall'],0)

    def test_grouping_and_identifier_boundaries_are_preserved(self):
        regions=self.regions();regions[0]['text']='(a + b) * c'
        for changed in ['a + b * c','(a - b) * c']:
            self.assertEqual(formula_region_diagnostics(regions,self.evidence(changed))['literalRegionRecall'],0)
        regions[0]['text']='alpha beta'
        self.assertEqual(formula_region_diagnostics(regions,self.evidence('alphabeta'))['literalRegionRecall'],0)

    def test_overlapping_regions_and_crossing_words_are_not_credited(self):
        regions=self.regions();regions.append({**regions[0],'blockId':'another-rule'})
        result=formula_region_diagnostics(regions,self.evidence())
        self.assertEqual(result['literalRegionRecall'],0)
        self.assertEqual(result['regions'][0]['issues'][0]['kind'],'competing-regions')
        for change in [dict(bboxNormalized=[0,.1,.11,.14]),dict(clippedByDisplay=True),dict(clippedByDisplay=None)]:
            evidence=self.evidence();evidence['words'][0].update(change)
            result=formula_region_diagnostics(self.regions(),evidence)
            self.assertFalse(result['regions'][0]['literalMatch'])
            self.assertEqual(result['regions'][0]['issues'][0]['kind'],'boundary-word')

    def test_invalid_or_missing_geometry_is_refused_without_mutation(self):
        evidence=self.evidence();regions=self.regions();before=copy.deepcopy((regions,evidence))
        formula_region_diagnostics(regions,evidence)
        self.assertEqual((regions,evidence),before)
        mutations=[lambda e:e.pop('normalizedBasis'),
                   lambda e:e['words'][0].update(bboxNormalized=[0,.1,float('nan'),.2]),
                   lambda e:e['words'][1].update(order=0)]
        for mutate in mutations:
            changed=copy.deepcopy(evidence);mutate(changed)
            with self.assertRaises(ValueError):formula_region_diagnostics(regions,changed)
        for bad in [None,[regions[0],regions[0]],[{**regions[0],'bboxNormalized':[-.1,0,.5,.5]}]]:
            with self.assertRaises(ValueError):formula_region_diagnostics(bad,evidence)


if __name__=='__main__':unittest.main()
