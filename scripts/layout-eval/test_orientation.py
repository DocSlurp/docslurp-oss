import unittest
from orientation import inverse_bbox,inverse_point,choose_orientation


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


if __name__=='__main__': unittest.main()
