"""Mock-only smoke orchestration: no SDK import, credentials, Docker or network."""
import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import modal_smoke as smoke


class FakeBackend:
    def __init__(self, *, create_delay=0, hang=False, wrong_result=False, terminate_hangs=False):
        self.creates = 0; self.terminates = 0; self.initialized = 0; self.input = 'original'; self.commands = []
        self.create_delay = create_delay; self.hang = hang; self.wrong_result = wrong_result; self.terminate_hangs = terminate_hangs

    async def initialize(self, app): self.initialized += 1
    async def create(self, run_id):
        self.creates += 1
        await asyncio.sleep(self.create_delay)
        return 'sb-synthetic-mock-only'
    async def write(self, data, path): pass
    async def terminate(self):
        self.terminates += 1
        if self.terminate_hangs: await asyncio.sleep(10)
    async def poll(self): return 137
    async def execute(self, command, seconds, stdout_limit):
        self.commands.append((command, seconds, stdout_limit))
        if self.hang: await asyncio.sleep(10)
        out, err, code = b'', b'', 0
        def encoded(value): return json.dumps(value).encode()
        if 'guest_smoke.py' in ' '.join(command):
            op = command[-1]
            if op in ('canonical',): out = encoded({'artifactSha256': smoke.BUNDLE})
            if op == 'pixels': out = encoded({'exactPixelRoundtrip': True, 'width': 800, 'height': 1000})
            if op == 'network': out = encoded({'outboundConnectionFailed': True})
            if op == 'resources': out = encoded({'cpuAffinityCount': 2})
            if op.startswith('stage:'): self.input = op.split(':')[1]
            if op == 'encode-stage': self.input = 'original'
        elif len(command) > 2 and command[2] == '/opt/docslurp/layout/runtime/vm_entry.py':
            request = json.loads(command[-1])
            reason = ('Unsupported model in this VM image' if request.get('model') != smoke.REQUEST['model']
                      else 'CUDA is unavailable behind the VM boundary' if request.get('device') != 'cpu' else None)
            for key in ('modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256'):
                if reason is not None: break
                if key not in request: reason = 'Missing required request identity'; break
                if request[key] != smoke.REQUEST[key]: reason = 'Model manifest identity mismatch'; break
            if reason is None:
                reason = {'malformed': 'cannot identify image file', 'oversized.png': 'Invalid image dimensions',
                          'animated.png': 'Invalid image dimensions', 'large': 'Oversized layout input'}.get(self.input)
            if reason: err = reason.encode(); code = 1
        elif smoke.READ_OUTPUT in command:
            result = {'image': {'width': 800, 'height': 1000, 'sha256': smoke.SOURCE_SHA},
                      'model': {'id': smoke.REQUEST['modelId'], 'revision': smoke.REVISION, 'artifactSha256': smoke.BUNDLE},
                      'inferenceProfileSha256': smoke.PROFILE, 'device': 'cpu'}
            if self.wrong_result: result['model']['artifactSha256'] = '0' * 64
            out = encoded(result)
        elif '/job/tampered' in ' '.join(command): err = b'Offline model asset hash mismatch'; code = 1
        elif 'encode-webp' in command and self.input in ('malformed', 'oversized.png', 'animated.png'):
            err = b'cannot identify image file' if self.input == 'malformed' else b'unsupported image dimensions or animation'; code = 1
        return out, err, code


class OneShotTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_cases_in_exactly_one_vm_and_verified_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); backend = FakeBackend()
            state = await smoke.run_smoke(backend, root / 'output', root / 'attempt.lock', 'existing-app')
            self.assertEqual(state['status'], 'checks-passed')
            self.assertEqual(backend.creates, 1); self.assertEqual(backend.terminates, 1)
            self.assertTrue(state['termination']['verified'])
            self.assertEqual(state['limits']['timeout'], 1800)
            self.assertEqual(state['limits']['cpu'], (2, 2)); self.assertEqual(state['limits']['memory'], (1024, 1024))
            self.assertTrue(state['limits']['block_network']); self.assertFalse(state['limits']['include_oidc_identity_token'])
            self.assertEqual(state['limits']['secrets'], []); self.assertEqual(state['limits']['volumes'], {})
            self.assertIsNone(state['providerUsage']['billedUsd'])
            self.assertIn('tampered-copy-refused', [c['name'] for c in state['checks']])
            self.assertTrue(all(seconds <= 55 for _, seconds, _ in backend.commands))
            self.assertTrue((root / 'output/layout.json').exists())
            with self.assertRaises(FileExistsError):
                await smoke.run_smoke(backend, root / 'another-output', root / 'attempt.lock', 'existing-app')
            self.assertEqual(backend.creates, 1)

    async def test_work_failure_and_deadline_never_recreate(self):
        for parameters in [{'hang': True}, {'wrong_result': True}]:
            with self.subTest(parameters=parameters), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); backend = FakeBackend(**parameters)
                state = await smoke.run_smoke(backend, root / 'output', root / 'attempt.lock', 'existing-app', work_seconds=.05, cleanup_seconds=.1)
                self.assertEqual(state['status'], 'failed'); self.assertEqual(backend.creates, 1)
                self.assertTrue(state['termination']['verified'])

    async def test_late_create_id_is_terminated_without_new_create(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); backend = FakeBackend(create_delay=.04)
            state = await smoke.run_smoke(backend, root / 'output', root / 'attempt.lock', 'existing-app', work_seconds=.01, cleanup_seconds=.3)
            self.assertEqual(backend.creates, 1); self.assertEqual(backend.terminates, 1)
            self.assertTrue(state['termination']['verified']); self.assertEqual(state['status'], 'failed')

    async def test_lost_create_and_stuck_cleanup_are_not_claimed_complete(self):
        for parameters in [{'create_delay': 10}, {'terminate_hangs': True}]:
            with self.subTest(parameters=parameters), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); backend = FakeBackend(**parameters)
                state = await smoke.run_smoke(backend, root / 'output', root / 'attempt.lock', 'existing-app', work_seconds=.05, cleanup_seconds=.06)
                self.assertEqual(backend.creates, 1)
                self.assertEqual(state['status'], 'cleanup-unverified-no-retry')
                self.assertFalse(state['termination']['verified'])

    async def test_binary_stream_limit_is_incremental(self):
        async def stream():
            yield b'x' * 8
            yield b'x' * 8
            raise AssertionError('Should stop before reading more')
        with self.assertRaisesRegex(ValueError, 'stream limit'):
            await smoke.bounded_stream(stream(), 10)


class PreflightTests(unittest.TestCase):
    def test_plan_never_imports_sdk_and_profile_auth_is_lazily_selected(self):
        with patch.dict(sys.modules, {'modal': None}):
            plan = smoke.plan()
        self.assertEqual(plan['mode'], 'plan-only-no-sdk-import')
        self.assertEqual(plan['limits']['timeout'], 1800)
        self.assertEqual(plan['aggregateAuthorizationUsd'], 20)

    def test_two_reviews_bind_exact_runner_and_image(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'reviews.json'
            review = {'runnerBundleSha256': smoke.bundle_sha(), 'imageDigest': smoke.IMAGE_DIGEST,
                      'reviewers': [{'id': 'independent-a', 'decision': 'approved', 'adversarial': True}, {'id': 'independent-b', 'decision': 'approved'}]}
            path.write_text(json.dumps(review)); smoke.validate_reviews(path)
            for field, bad in [('runnerBundleSha256', '0' * 64), ('imageDigest', 'sha256:' + '0' * 64),
                               ('reviewers', [review['reviewers'][0]]), ('reviewers', [review['reviewers'][0]] * 2)]:
                invalid = {**review, field: bad}; path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError): smoke.validate_reviews(path)


if __name__ == '__main__': unittest.main()
