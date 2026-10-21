import unittest
from compare import paired_comparison


class CompareTests(unittest.TestCase):
    def test_source_cluster_groups_repeat_and_capture(self):
        baseline={}; candidate={}
        region={'label':'table','bbox':[0,0,1,1]}
        for source in ('a','b'):
            for capture in ('clean','scan'):
                for repeat in range(2):
                    key=(source+'-'+capture,repeat)
                    row={'page_id':key[0],'repeat':repeat,'truth':[region],'regions':[region],
                         'metadata':{'source_id':source,'source_family':'table'}}
                    baseline[key]=row; candidate[key]=dict(row,regions=[])
        output=paired_comparison(baseline,candidate,replicates=50)
        self.assertEqual(output['sources'],2); self.assertEqual(output['paired_image_repeats'],8)
        self.assertEqual(output['candidate_minus_baseline']['micro_f1'],-1)
        self.assertEqual(output['delta_confidence95_percentile']['micro_f1'],{'low':-1,'high':-1})
        self.assertEqual(output['per_family']['table']['sources'],2)

    def test_mismatched_pairs_and_references_fail(self):
        with self.assertRaises(ValueError): paired_comparison({('a',0):{}},{})
        row={'truth':[],'regions':[],'metadata':{'source_id':'a'}}
        with self.assertRaises(ValueError): paired_comparison({('a',0):row},{('a',0):dict(row,truth=[{}])})


if __name__=='__main__': unittest.main()
