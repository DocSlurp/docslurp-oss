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

    def test_long_documents_convert_only_in_bounded_shards(self):
        pages = 25000
        with self.assertRaises(ValueError): guest.page_ranges(pages)                      # whole document: refused
        with self.assertRaises(ValueError): guest.page_ranges(pages, 1, 10016)            # one VM over the limit
        self.assertEqual(guest.page_ranges(pages, 9985, 19968)[-1], (19937, 19968))       # 9,984-page shard: allowed
        self.assertEqual(guest.page_ranges(pages, 19969, 25000)[-1], (24993, 25000))
        with self.assertRaises(ValueError): guest.page_ranges(guest.MAX_DOCUMENT_PAGES + 1, 1, 32)
        self.assertEqual(self_request(pages, {"first": 19969, "last": 25000, "final": True}), (19969, 25000))

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

def self_request(pages, body):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "shard.json"; path.write_text(json.dumps(body))
        return guest.shard_request(pages, path)

class ShardRequestTest(unittest.TestCase):
    def request(self, pages, body):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "shard.json"
            if body is not None:
                path.write_bytes(body if isinstance(body, bytes) else json.dumps(body).encode())
            return guest.shard_request(pages, path)

    def test_absent_request_is_the_whole_document(self):
        self.assertEqual(self.request(67, None), (1, 67))

    def test_aligned_shards_reproduce_the_whole_document_chunks(self):
        for pages in (33, 64, 65, 477, 998):
            whole = guest.page_ranges(pages)
            for size in (32, 64, 96):
                pieces = []
                for first in range(1, pages + 1, size):
                    last = min(pages, first + size - 1)
                    self.assertEqual(self.request(pages, {"first": first, "last": last, "final": last == pages}), (first, last))
                    pieces += guest.page_ranges(pages, first, last)
                self.assertEqual(pieces, whole)

    def test_refuses_malformed_unaligned_or_out_of_range_requests(self):
        bad = [
            {"first": 2, "last": 32, "final": False},            # off the chunk grid
            {"first": 1, "last": 40, "final": False},            # non-final end off the grid
            {"first": 33, "last": 64, "final": True},            # claims final short of the last page
            {"first": 33, "last": 67, "final": False},           # ends on the last page without final
            {"first": 65, "last": 96, "final": False},           # past the document
            {"first": 0, "last": 32, "final": False},
            {"first": 1, "last": 32},                            # missing key
            {"first": 1, "last": 32, "final": False, "x": 1},    # extra key
            {"first": "1", "last": 32, "final": False},
            {"first": True, "last": 32, "final": False},
            {"first": 1, "last": 32, "final": 0},
            [1, 32],
            b"x" * (guest.MAX_SHARD_REQUEST + 1),
            b"not json",
        ]
        for body in bad:
            with self.assertRaises(ValueError, msg=repr(body)): self.request(67, body)

    def test_refuses_symlinked_request(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "real"; target.write_text('{"first":1,"last":32,"final":false}')
            link = Path(d) / "shard.json"; link.symlink_to(target)
            with self.assertRaises(ValueError): guest.shard_request(67, link)

if __name__ == "__main__": unittest.main()
