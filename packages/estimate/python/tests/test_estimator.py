import json
import pathlib
import threading
import unittest

from docslurp_estimate import Estimator, EstimatorError

PACKAGE = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = PACKAGE / "tests" / "fixtures"
CARD = json.loads((PACKAGE / "card.json").read_text())
GOLDEN = json.loads((PACKAGE / "golden" / "cases.json").read_text())


class EstimatorTest(unittest.TestCase):
    estimator = Estimator()

    def test_bundles_the_generated_card(self):
        self.assertEqual(self.estimator.card()["revision"], CARD["revision"])

    def test_quotes_match_the_typescript_golden_cases(self):
        for index, case in enumerate(GOLDEN["quote"]):
            request = case["input"]
            files = [{**file, "mixConfidence": min(1, max(0, file["mixConfidence"]))} if "mixConfidence" in file else file for file in request["files"]]
            if files != request["files"]:
                continue  # out-of-range confidences are a 400 at the API; the Rust port tests them directly
            quote = self.estimator.quote(files, request["profile"], request.get("speedBoost"))
            self.assertEqual({"estimate": quote["estimate"], "media": quote["media"]}, case["output"], f"quote[{index}]")

    def test_probes_and_prices_files_on_disk(self):
        quote = self.estimator.quote_paths([FIXTURES / "scan_plain.pdf", FIXTURES / "text_wrapped_with_photo.pdf"])
        self.assertEqual(quote["estimate"]["pages"], 2)
        self.assertEqual([probe["mix"]["scanned"] for probe in quote["probes"]], [1, 0])
        self.assertIn("page mix known for every file", quote["estimate"]["basis"])

    def test_estimate_paths_reports_progress_in_order(self):
        events = []
        result = self.estimator.estimate_paths([FIXTURES / "scan_plain.pdf", FIXTURES / "missing.pdf", FIXTURES / "text_wrapped_with_photo.pdf"], on_progress=events.append)
        self.assertEqual(events[-1]["type"], "quote-done")
        first = [event["type"] for event in events if event.get("file", {}).get("index") == 0]
        self.assertEqual(first, ["file-start", "read-progress", "probe-start", "probe-done", "file-done"])
        self.assertEqual([file["status"] for file in result["files"]], ["probed", "failed", "probed"])
        self.assertEqual(result["files"][1]["reason"]["code"], "read_failed")
        self.assertEqual(result["stats"]["pages"]["found"], 2)
        self.assertTrue(result["partial"])
        self.assertFalse(result["cancelled"])
        self.assertFalse(any("percent" in key for event in events for key in event))
        expected = self.estimator.quote_paths([FIXTURES / "scan_plain.pdf", FIXTURES / "text_wrapped_with_photo.pdf"])
        self.assertEqual(result["stats"]["bytes"]["read"], result["stats"]["bytes"]["planned"])
        self.assertEqual(result["quote"]["estimate"]["pages"], expected["estimate"]["pages"] + 1)

    def test_estimate_paths_stops_when_cancelled(self):
        cancel = threading.Event()
        paths = [FIXTURES / "scan_plain.pdf"] * 20

        def on_progress(event):
            if event["type"] == "file-done" and event["files"]["completed"] == 3:
                cancel.set()

        result = self.estimator.estimate_paths(paths, on_progress=on_progress, cancel=cancel)
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["stats"]["files"]["probed"], 3)
        self.assertEqual(result["stats"]["files"]["skipped"], 17)
        self.assertEqual(result["quote"]["estimate"]["documents"], 20)

    def test_refuses_what_it_cannot_price(self):
        with self.assertRaises(EstimatorError) as caught:
            self.estimator.quote([{"name": "a.pdf", "size": 1}], {**CARD["defaultProfile"], "quality": "ultra"})
        self.assertEqual(caught.exception.code, "unsupported_rules")
        with self.assertRaises(EstimatorError) as caught:
            Estimator(card={**CARD, "rules": CARD["rules"] + 1}).quote([{"name": "a.pdf", "size": 1}])
        self.assertEqual(caught.exception.code, "unsupported_rules")

    def test_supplied_cards_are_reported(self):
        quote = Estimator(card=CARD).quote([{"name": "a.pdf", "size": 1}])
        self.assertEqual(quote["card"]["source"], "supplied")


if __name__ == "__main__":
    unittest.main()
