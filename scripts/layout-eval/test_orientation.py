import unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
from PIL import Image
from orientation import inverse_bbox,inverse_point,choose_orientation,OnnxOrientation


class OrientationTests(unittest.TestCase):
    def test_right_angle_inverse_boxes(self):
        original=[.1,.2,.4,.6]
        corrected={0:original,90:[.2,.6,.6,.9],180:[.6,.4,.9,.8],270:[.4,.1,.8,.4]}
        for angle,box in corrected.items():
            for actual,expected in zip(inverse_bbox(box,angle),original): self.assertAlmostEqual(actual,expected)

    def test_classifier_abstains_without_using_references(self):
        decision=choose_orientation([.1,.7,.1,.1],.75)
        self.assertEqual(decision['predicted_angle'],90); self.assertEqual(decision['correction_angle'],0)
        decision=choose_orientation([.01,.97,.01,.01],.75)
        self.assertEqual(decision['correction_angle'],90)

    def test_bad_angles_or_logits_fail(self):
        with self.assertRaises(ValueError): inverse_point(.1,.2,45)
        with self.assertRaises(ValueError): choose_orientation([0,1,2,3])
        with self.assertRaises(ValueError): choose_orientation([.8,.8,.8,.8])

    def test_extreme_aspect_ratio_rejected_before_resize(self):
        resize=Mock(side_effect=AssertionError('Must not allocate oversized orientation input'))
        detector=OnnxOrientation.__new__(OnnxOrientation)
        with patch.dict('sys.modules',cv2=SimpleNamespace(resize=resize,INTER_LINEAR=1)):
            for size in ((1,100000),(100000,1)):
                with self.assertRaisesRegex(ValueError,'16 million pixels'):
                    detector.classify([Image.new('RGB',size)])
        resize.assert_not_called()

    def test_normal_resize_and_center_crop_are_unchanged(self):
        import numpy as np
        # Exercise the real interpolation path and inspect the exact classifier input.
        import cv2
        image=Image.fromarray(np.random.default_rng(7).integers(0,256,(800,600,3),dtype=np.uint8))
        expected=cv2.resize(np.asarray(image),(256,341),interpolation=cv2.INTER_LINEAR)
        expected=expected[(341-224)//2:(341-224)//2+224,(256-224)//2:(256-224)//2+224].astype(np.float32)*(1./255.)
        expected=(expected-np.array([.485,.456,.406],dtype=np.float32))/np.array([.229,.224,.225],dtype=np.float32)
        session=Mock()
        session.get_inputs.return_value=[SimpleNamespace(name='image')]
        session.run.return_value=[np.array([[1.,0.,0.,0.]])]
        detector=OnnxOrientation.__new__(OnnxOrientation);detector.session=session;detector.minimum_score=.75
        decisions,_=detector.classify([image])
        self.assertEqual(decisions[0]['correction_angle'],0)
        np.testing.assert_array_equal(session.run.call_args.args[1]['image'],expected.transpose(2,0,1)[None])


if __name__=='__main__': unittest.main()
