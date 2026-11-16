import json
import pathlib
import threading
import unittest

from docslurp_estimate import Estimator, EstimatorError

PACKAGE = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = PACKAGE / "tests" / "fixtures"
PRICING_WORDS = ("credit", "price", "priced", "bill", "rich", "fast", "cost", "free", "mix", "quote")


def many_objects_pdf(objects: int, pages: int = 1, declared_size: int | None = None) -> bytes:
    """`pages` text pages and `objects` small filler dictionaries in a classic xref (see test/hostile.mjs)."""
    chunks = [b"%PDF-1.7\n"]
    length = len(chunks[0])
    offsets = [0]

    def put(number: int, body: str) -> None:
        nonlocal length
        offsets.append(length)
        chunk = f"{number} 0 obj\n{body}\nendobj\n".encode()
        chunks.append(chunk)
        length += len(chunk)

    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(pages))
    put(1, "<< /Type /Catalog /Pages 2 0 R >>")
    put(2, f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>")
    for i in range(pages):
        content = f"BT /F1 12 Tf 72 720 Td (Revenue beat the forecast on page {i + 1}.) Tj ET"
        put(3 + 2 * i, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R >>")
        put(4 + 2 * i, f"<< /Length {len(content)} >>\nstream\n{content}\nendstream")
    for i in range(objects):
        put(3 + 2 * pages + i, f"<< /A {i} /B [1 2 3] >>")
    count = len(offsets)
    rows = "".join(f"{offset:010d} 00000 n \n" for offset in offsets[1:])
    chunks.append(f"xref\n0 {count}\n0000000000 65535 f \n{rows}trailer\n<< /Size {declared_size or count} /Root 1 0 R >>\nstartxref\n{length}\n%%EOF\n".encode())
    return b"".join(chunks)


class EstimatorTest(unittest.TestCase):
    estimator = Estimator()

    def test_reports_its_profile_schema(self):
        self.assertEqual(self.estimator.info()["profileSchema"], 1)

    def test_jsonl_header_close_releases_session(self):
        stream = self.estimator.profile_jsonl(FIXTURES / "scan_plain.pdf")
        self.assertEqual(json.loads(next(stream))["t"], "header")
        stream.close()
        records = [json.loads(line) for line in self.estimator.profile_jsonl(FIXTURES / "scan_plain.pdf")]
        self.assertTrue(records[-1]["complete"])
        self.assertEqual(records[-1]["deepMeasured"], 1)

    def test_jsonl_cancellation_and_terminal_are_unambiguous(self):
        cancel = threading.Event()
        stream = self.estimator.profile_jsonl(FIXTURES / "scan_plain.pdf", cancel=cancel)
        next(stream)
        cancel.set()
        self.assertFalse(json.loads(next(stream))["complete"])
        stream.close()
        cancel.clear()
        records = []
        for line in self.estimator.profile_jsonl(FIXTURES / "scan_plain.pdf", cancel=cancel):
            record = json.loads(line)
            records.append(record)
            if record["t"] == "end":
                cancel.set()
        self.assertEqual(len([r for r in records if r["t"] == "end"]), 1)

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


    def test_input_larger_than_memory_is_out_of_memory_and_recovers(self):
        huge = bytes(300 * 1024 * 1024)
        with self.assertRaises(EstimatorError) as caught:
            self.estimator.profile("huge.pdf", len(huge), huge)
        self.assertEqual(caught.exception.code, "out_of_memory")
        self.assertIn("allocation was refused", str(caught.exception))
        self.assertIn("profileSchema", self.estimator.info())

    def test_a_file_that_exhausts_memory_does_not_starve_later_files(self):
        fresh = Estimator()
        # Declares 10 objects, holds 400,000: the whole load fills the memory and traps; the retry reads the page tree.
        liar = many_objects_pdf(400_000, pages=2, declared_size=10)
        lied = fresh.profile("liar.pdf", len(liar), liar)
        self.assertEqual(lied["pages"], 2)
        self.assertNotIn("pdf", lied)
        self.assertTrue(any("retried without loading" in note for note in lied["notes"]), lied["notes"])
        self.assertEqual(fresh.health()["crashes"], 1)
        # About 90 MiB loaded: more than a memory the liar grew past 200 MiB had left before the fix.
        heavy = many_objects_pdf(100_000, pages=3)
        profiled = fresh.profile("heavy.pdf", len(heavy), heavy)
        self.assertEqual(profiled["pages"], 3)
        self.assertEqual(profiled["pdf"]["sampledPages"], 3)
        self.assertEqual(fresh.health()["crashes"], 1)


if __name__ == "__main__":
    unittest.main()
