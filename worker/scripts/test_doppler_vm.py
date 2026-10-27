"""Pure range/merge regressions; no PDF parser or provider is executed."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("doppler_vm", Path(__file__).with_name("doppler-vm.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)

class ChunkMergeTest(unittest.TestCase):
    def test_short_tail_cannot_lower_furniture_repetition_threshold(self):
        for document_pages in (1, 32, 33, 67, 10000):
            for first, last in guest.page_ranges(document_pages):
                count = last - first + 1
                params = json.loads(guest.chunk_settings('{"tables":true}', document_pages, count))
                self.assertAlmostEqual(params['furniture_min_share'] * count, 0.4 * document_pages)
                self.assertTrue(params['tables'])
        params = json.loads(guest.chunk_settings('{"furniture_min_share":0.6}', 67, 3))
        self.assertAlmostEqual(params['furniture_min_share'] * 3, 40.2)

    def test_ranges_cover_every_page_once(self):
        for pages in (1, 31, 32, 33, 64, 65, 10000):
            ranges = guest.page_ranges(pages)
            self.assertEqual([p for first, last in ranges for p in range(first, last + 1)], list(range(1, pages + 1)))
            self.assertTrue(all(last - first + 1 <= 32 for first, last in ranges))
        for pages in (0, -1, 10001, True, 1.5):
            with self.assertRaises(ValueError): guest.page_ranges(pages)

    def test_order_and_blank_slots_across_chunk_boundaries(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d); output = p / "merged"; size = 0
            chunks = [b"first\f\fthird", b"\ffifth\f", b"last"]
            with output.open("wb") as f:
                for i, data in enumerate(chunks):
                    chunk = p / "chunk"; chunk.write_bytes(data)
                    size = guest.append_chunk(f, chunk, data.count(b"\f") + 1, i == 0, size)
            self.assertEqual(output.read_bytes(), b"first\f\fthird\f\ffifth\f\flast")
            self.assertEqual(size, output.stat().st_size)

    def test_refuses_wrong_page_count_and_oversize_merge(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d); chunk = p / "chunk"; chunk.write_bytes(b"one")
            with (p / "out").open("wb") as f:
                with self.assertRaises(ValueError): guest.append_chunk(f, chunk, 2, True, 0)
                with self.assertRaises(ValueError): guest.append_chunk(f, chunk, 1, False, guest.MAX_OUTPUT - 2)

if __name__ == "__main__": unittest.main()
