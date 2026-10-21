import copy
import unittest
from select_cpu_runtime import select_runtime


def summary(latency=20,macro=.5,localization_f1=.8,localization_recall=.8):
    return {'failures':0,'scores':{'iou50':{'macro_f1_truth_present':macro,
            'class_agnostic_localization':{'f1':localization_f1,'recall':localization_recall}}},
            'per_family':{'magazine':{'iou50':{'macro_f1_truth_present':macro}}},
            'successful_latency_ms':{'consumer_path_ms':{'mean':latency}}}


class SelectionTests(unittest.TestCase):
    def test_visual_suppression_cannot_win_strict_f1(self):
        jobs=[{'name':'ort-fp32-t1'},{'name':'destructive'}]
        evidence={'ort-fp32-t1':summary(),'destructive':summary(5,.6,.7,.7)}
        result=select_runtime(evidence,jobs)
        self.assertEqual(result['selected']['name'],'ort-fp32-t1')
        self.assertIn('class-agnostic localization recall drop > 2pp',result['decisions'][1]['reasons'])

    def test_eligible_fastest_runtime_wins(self):
        jobs=[{'name':'ort-fp32-t1'},{'name':'fast'}]
        result=select_runtime({'ort-fp32-t1':summary(),'fast':summary(10,.495,.799,.799)},jobs)
        self.assertEqual(result['selected']['name'],'fast')


if __name__=='__main__': unittest.main()
