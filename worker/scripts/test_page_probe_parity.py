import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import page_probe_parity as parity  # noqa: E402


def row(page, **kw):
    base = {"pageNumber": page, "textLayerStatus": "ok", "charCount": 1000, "textCoverage": 0.3, "unusualFeatures": [], "needsAttention": False,
            "textFacts": {"line": "x"}}
    base.update(kw)
    return base


class ParityTest(unittest.TestCase):
    def test_close_uses_the_documented_tolerances(self):
        self.assertTrue(parity.close("abs", 0.02, 0.30, 0.31))
        self.assertFalse(parity.close("abs", 0.02, 0.30, 0.35))
        self.assertTrue(parity.close("rel", 0.02, 1000, 1015))
        self.assertTrue(parity.close("exact", 0, None, None))
        self.assertFalse(parity.close("exact", 0, None, 0))

    def test_report_counts_status_and_feature_disagreements(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            jobs = [{"id": "a::one", "set": "a", "split": "development", "path": str(tmp / "x.pdf")}]
            (tmp / "jobs.json").write_text(json.dumps(jobs))
            py = {"id": "a::one", "rows": [row(1), row(2, unusualFeatures=["link-uri"])], "error": None, "seconds": 0.4}
            nat = {"id": "a::one", "rows": [row(1), row(2, textLayerStatus="suspect", unusualFeatures=[])], "error": None, "seconds": 0.1}
            (tmp / "py.jsonl").write_text(json.dumps(py) + "\n")
            (tmp / "nat.jsonl").write_text(json.dumps(nat) + "\n")
            parity.main([str(tmp / "jobs.json"), str(tmp / "py.jsonl"), str(tmp / "nat.jsonl"), "--out", str(tmp / "r.json")])
            rep = json.loads((tmp / "r.json").read_text())
        self.assertEqual(rep["pages"], 2)
        self.assertEqual(rep["textLayerStatusMatrix"], {"ok->ok": 1, "ok->suspect": 1})
        self.assertEqual(rep["unusualFeaturesPageExact"], {"same": 1, "differ": 1})
        self.assertEqual(rep["unusualFeatureCounts"]["link-uri"], {"py-only": 1})
        self.assertAlmostEqual(rep["fields"]["textLayerStatus"]["agree"], 0.5)


if __name__ == "__main__":
    unittest.main()
