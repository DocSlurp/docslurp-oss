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

    def test_review_regressions_never_receive_perfect_credit(self):
        omml = ('<m:oMath xmlns:m="http://schemas.openxmlformats.org/'
                'officeDocument/2006/math"><m:r><m:t>x^2</m:t></m:r></m:oMath>')
        styled = ('<math xmlns="http://www.w3.org/1998/Math/MathML">'
                  '<mstyle mathvariant="bold"><mtext>x</mtext></mstyle></math>')
        nul_xml = ('<!DOCTYPE math SYSTEM "file:///nonexistent-control">'
                   '<math><mi>x</mi></math>').encode('utf-16-le').decode('latin1')
        for reference, candidate, encoding, wanted in [
            ('(x^2)_i', 'x_i^2', 'auto', 0),
            ('x^2', omml, 'omml', None),
            (r'\mathbb{d}', 'ⅆ', 'unicode', None),
            (r'\mathrm{x}', styled, 'mathml', 0),
            ('x', nul_xml, 'mathml', None),
        ]:
            with self.subTest(reference=reference, candidate=candidate):
                result = score_request({"reference": reference, "candidate": candidate,
                                        "candidateEncoding": encoding})
                self.assertEqual(result['score'], wanted)
                self.assertFalse(result['acceptanceEvidenceComplete'])

    def test_second_review_style_and_empty_run_regressions(self):
        for reference, candidate in [
            ('7', '<math><mstyle mathvariant="bold"><mn>7</mn></mstyle></math>'),
            ('q^i', 'qᶦ'),
        ]:
            with self.subTest(candidate=candidate):
                result = score_request({"reference": reference, "candidate": candidate})
                self.assertNotEqual(result['score'], 1)
                self.assertFalse(result['acceptanceEvidenceComplete'])
        normal = '<m:rPr><m:nor/></m:rPr>'
        candidate = (
            '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
            f'<m:r>{normal}<m:t>m</m:t></m:r><m:r><m:t></m:t></m:r>'
            f'<m:r>{normal}<m:t>ol</m:t></m:r></m:oMath>'
        )
        result = score_request({"reference": r'\mathrm{mol}', "candidate": candidate})
        self.assertEqual(result['score'], 1)
        self.assertFalse(result['acceptanceEvidenceComplete'])


if __name__ == "__main__":
    unittest.main()
