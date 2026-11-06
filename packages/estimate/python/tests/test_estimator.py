import json
import pathlib
import threading
import unittest

from docslurp_estimate import Estimator, EstimatorError

PACKAGE = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = PACKAGE / "tests" / "fixtures"
PRICING_WORDS = ("credit", "price", "priced", "bill", "rich", "fast", "cost", "free", "mix", "quote")


class EstimatorTest(unittest.TestCase):
    estimator = Estimator()

    def test_reports_its_profile_schema(self):
        self.assertEqual(self.estimator.info()["profileSchema"], 1)

    def test_profiles_files_on_disk_with_neutral_facts_only(self):
        scan = self.estimator.profile_path(FIXTURES / "scan_plain.pdf")
        text = self.estimator.profile_path(FIXTURES / "text_wrapped_with_photo.pdf")
        self.assertEqual((scan["kind"], scan["pages"], scan["pdf"]["rasterPages"]), ("pdf", 1, 1))
        self.assertEqual((text["pdf"]["rasterPages"], text["pdf"]["layoutHeavyPages"]), (0, 1))
        for profile in (scan, text):
            encoded = json.dumps(profile).lower()
            self.assertLessEqual(len(encoded), 4096)
            for word in PRICING_WORDS:
                self.assertNotIn(word, encoded)

    def test_estimate_paths_reports_progress_in_order(self):
        events = []
        result = self.estimator.estimate_paths([FIXTURES / "scan_plain.pdf", FIXTURES / "missing.pdf", FIXTURES / "text_wrapped_with_photo.pdf"], on_progress=events.append)
        self.assertEqual(events[-1]["type"], "done")
        first = [event["type"] for event in events if event.get("file", {}).get("index") == 0]
        self.assertEqual(first, ["file-start", "read-progress", "probe-start", "probe-done", "file-done"])
        self.assertEqual([file["status"] for file in result["files"]], ["probed", "failed", "probed"])
        self.assertEqual(result["files"][1]["reason"]["code"], "read_failed")
        self.assertEqual(result["stats"]["pages"]["found"], 2)
        self.assertTrue(result["partial"])
        self.assertFalse(result["cancelled"])
        self.assertFalse(any("percent" in key for event in events for key in event))
        self.assertEqual(result["stats"]["bytes"]["read"], result["stats"]["bytes"]["planned"])
        request = result["request"]["files"]
        self.assertEqual([("profile" in file) for file in request], [True, False, True])
        self.assertEqual(request[1], {"name": "missing.pdf", "size": 0})

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
        self.assertEqual(len(result["request"]["files"]), 20)

    def test_refuses_malformed_requests(self):
        with self.assertRaises(EstimatorError) as caught:
            self.estimator._call("ds_read_plan", b"{not json")
        self.assertEqual(caught.exception.code, "invalid_request")


if __name__ == "__main__":
    unittest.main()
