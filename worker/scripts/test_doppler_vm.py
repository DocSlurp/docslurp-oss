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

    def test_document_limit_boundaries_and_settings_scale(self):
        self.assertEqual(guest.page_ranges(100000, 1, 10000)[-1], (9985, 10000))
        with self.assertRaises(ValueError): guest.page_ranges(100000, 1, 10001)
        with self.assertRaises(ValueError): guest.page_ranges(100001, 1, 32)
        self.assertEqual(self_request(100000, {"first": 99969, "last": 100000, "final": True}), (99969, 100000))
        for pages in (25000, 100000):
            for count in (32, 1):
                share = json.loads(guest.chunk_settings('{}', pages, count))['furniture_min_share']
                self.assertTrue(share == share and share < float('inf'))  # finite; furniture never repeats past 1.0

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

def _layers_available():
    try:
        import ctypes
        if ctypes.CDLL(None, use_errno=True).syscall(444, None, 0, 1) < 4:
            return False
        ctypes.CDLL('libseccomp.so.2')
        return True
    except OSError:
        return False


@unittest.skipUnless(_layers_available(), "needs Landlock ABI >= 4 and libseccomp (CI asserts both on Linux)")
class HardeningTest(unittest.TestCase):
    """Applies the real Landlock and seccomp layers in a child process (needs Landlock ABI >= 4 and libseccomp)."""

    def run_hardened(self, probe):
        import subprocess, sys
        with tempfile.TemporaryDirectory() as job, tempfile.TemporaryDirectory() as outside:
            code = (f"import importlib.util, json, os, socket, ctypes\n"
                    f"spec = importlib.util.spec_from_file_location('g', {str(Path(__file__).with_name('doppler-vm.py'))!r})\n"
                    f"g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
                    f"job, outside = {job!r}, {outside!r}\n"
                    f"report = g.harden(job)\n{probe}")
            return subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=30)

    def test_job_directory_still_works(self):
        out = self.run_hardened("open(os.path.join(job, 'x'), 'w').write('ok'); os.unlink(os.path.join(job, 'x')); print(json.dumps(report))")
        self.assertEqual(out.returncode, 0, out.stderr)
        report = json.loads(out.stdout)
        self.assertTrue(report['noNewPrivs']); self.assertGreaterEqual(report['landlockAbi'], 4); self.assertGreater(report['seccompDenied'], 30)

    def test_refuses_writes_outside_job_sockets_ptrace_and_namespaces(self):
        probe = """
results = {}
for name, attempt in {
    'write_outside': lambda: open(os.path.join(outside, 'x'), 'w'),
    'write_etc': lambda: open('/etc/doppler-escape', 'w'),
    'socket': lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM),
    'unix_socket': lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM),
}.items():
    try: attempt(); results[name] = 'allowed'
    except OSError: results[name] = 'refused'
libc = ctypes.CDLL(None, use_errno=True)
results['ptrace'] = 'refused' if libc.ptrace(0, 0, None, None) == -1 else 'allowed'
results['unshare'] = 'refused' if libc.unshare(0x10000000) == -1 else 'allowed'
print(json.dumps(results))"""
        out = self.run_hardened(probe)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(set(json.loads(out.stdout).values()), {'refused'}, out.stdout)

    def test_council_gaps_are_closed(self):
        probe = r"""
import errno, subprocess
results = {}
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
def errno_of(rc): return 'refused' if rc == -1 else 'allowed'
results['clone3'] = 'refused' if libc.syscall(435, None, 0) == -1 and ctypes.get_errno() == errno.ENOSYS else 'allowed'
results['clone_newuser'] = errno_of(libc.syscall(56, 0x10000000 | 17, 0, 0, 0, 0))
results['chmod_outside'] = 'allowed'
victim = os.path.join(outside, 'v')
try:
    os.chmod(victim, 0o777)
except OSError:
    results['chmod_outside'] = 'refused'
results['memfd'] = errno_of(libc.syscall(319, b'x', 0))
results['shmget'] = errno_of(libc.shmget(0, 4096, 0o1600))
try:
    open(f'/proc/{os.getppid()}/fd/2', 'w'); results['parent_fd'] = 'allowed'
except OSError:
    results['parent_fd'] = 'refused'
results['child_runs'] = 'ok' if subprocess.run(['/usr/bin/true']).returncode == 0 else 'broken'
print(json.dumps(results))"""
        import subprocess, sys
        with tempfile.TemporaryDirectory() as job, tempfile.TemporaryDirectory() as outside:
            Path(outside, 'v').write_text('x')
            code = (f"import importlib.util, json, os, ctypes\n"
                    f"spec = importlib.util.spec_from_file_location('g', {str(Path(__file__).with_name('doppler-vm.py'))!r})\n"
                    f"g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
                    f"job, outside = {job!r}, {outside!r}\nreport = g.harden(job)\n{probe}")
            out = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        results = json.loads(out.stdout)
        self.assertEqual(results.pop('child_runs'), 'ok')
        self.assertEqual(set(results.values()), {'refused'}, results)

    def test_unknown_syscall_name_refuses_instead_of_skipping(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory() as job:
            code = (f"import importlib.util\n"
                    f"spec = importlib.util.spec_from_file_location('g', {str(Path(__file__).with_name('doppler-vm.py'))!r})\n"
                    f"g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
                    f"g.SECCOMP_DENY = g.SECCOMP_DENY + ('no_such_syscall_doppler',)\n"
                    f"try:\n    g.harden({job!r}); print('applied')\nexcept ValueError as e:\n    print('refused', e)")
            out = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=30)
        self.assertTrue(out.stdout.startswith('refused'), out.stdout + out.stderr)

    def test_root_capabilities_are_dropped(self):
        import shutil, subprocess, sys
        if not shutil.which('unshare'):
            self.skipTest('unshare unavailable')
        with tempfile.TemporaryDirectory() as job:
            code = (f"import importlib.util, json\n"
                    f"spec = importlib.util.spec_from_file_location('g', {str(Path(__file__).with_name('doppler-vm.py'))!r})\n"
                    f"g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
                    f"before = g._status('CapEff')\nreport = g.harden({job!r})\n"
                    f"print(json.dumps({{'before': before, 'report': report}}))")
            out = subprocess.run(['unshare', '--map-root-user', sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=30)
        if out.returncode != 0 and 'unshare' in out.stderr:
            self.skipTest('user namespaces unavailable: ' + out.stderr[:80])
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout)
        self.assertNotEqual(int(result['before'], 16), 0)        # root in the namespace held capabilities
        self.assertEqual(result['report']['capabilities'], 0)
        self.assertTrue(result['report']['boundingCleared'])

    def test_confinement_failure_exits_with_its_own_code(self):
        import subprocess, sys
        code = (f"import importlib.util\n"
                f"spec = importlib.util.spec_from_file_location('g', {str(Path(__file__).with_name('doppler-vm.py'))!r})\n"
                f"g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n"
                f"g.resource.setrlimit = lambda *a: None\n"
                f"def broken(job='/job'): raise ValueError('landlock unavailable')\n"
                f"g.harden = broken\ng.entry()")
        out = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 3, out.stderr)
        self.assertIn('confinement unavailable', out.stderr)

if __name__ == "__main__": unittest.main()
