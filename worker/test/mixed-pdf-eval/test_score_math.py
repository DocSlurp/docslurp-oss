import unittest

from score_math import score_request


class MathScorerTests(unittest.TestCase):
    def test_cross_format_and_structural_difference(self):
        mathml = ('<math xmlns="http://www.w3.org/1998/Math/MathML">'
                  '<mfrac><mi>a</mi><mi>b</mi></mfrac></math>')
        result = score_request({"reference": r"\frac{a}{b}", "candidate": mathml})
        self.assertEqual(result["score"], 1)
        self.assertTrue(result["encodingEvidenceComplete"])
        self.assertFalse(result["acceptanceEvidenceComplete"])
        changed = score_request({"reference": "a/b", "candidate": "b/a"})
        self.assertEqual(changed["score"], 0)

    def test_unsupported_does_not_acquire_perfect_aggregate(self):
        result = score_request({"pairs": [
            {"id": "same", "reference": "a/b", "candidate": "a/b"},
            {"id": "unknown", "reference": "a/b", "candidate": r"\unsupported{a}"},
        ]})
        self.assertIsNone(result["score"])
        self.assertFalse(result["encodingEvidenceComplete"])
        self.assertEqual(result["supportedPairs"], 1)

    def test_request_validation(self):
        for request in [[], {"pairs": []}, {"pairs": [1]},
                        {"reference": 1, "candidate": "a"},
                        {"reference": "a", "candidate": "a", "referenceEncoding": 3},
                        {"pairs": [{"id": "same", "reference": "a", "candidate": "a"}] * 2},
                        {"pairs": [{"reference": "a", "candidate": "a"}] * 33}]:
            with self.subTest(request=request):
                with self.assertRaises(ValueError):
                    score_request(request)


if __name__ == "__main__":
    unittest.main()
