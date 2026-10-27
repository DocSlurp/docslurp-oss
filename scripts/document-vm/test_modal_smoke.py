"""Mock-only smoke orchestration: no SDK import, credentials, Docker or network."""
import asyncio
import copy
import contextlib
import io
import json
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

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


class RegistryCredentialTests(unittest.IsolatedAsyncioTestCase):
    def setup_backend(self, create_error=None):
        async def empty():
            if False: yield b''
        child = SimpleNamespace(stdout=empty(), stderr=empty(), wait=SimpleNamespace(aio=AsyncMock(return_value=0)))
        vm = SimpleNamespace(object_id='sb-registry-mock-only', exec=SimpleNamespace(aio=AsyncMock(return_value=child)),
            filesystem=SimpleNamespace(make_directory=SimpleNamespace(aio=AsyncMock()), write_bytes=SimpleNamespace(aio=AsyncMock())))
        sdk = SimpleNamespace(Secret=SimpleNamespace(from_dict=Mock(return_value=object())),
            Image=SimpleNamespace(from_registry=Mock(return_value=object())),
            Sandbox=SimpleNamespace(create=SimpleNamespace(aio=AsyncMock(return_value=vm))))
        if create_error is not None: sdk.Sandbox.create.aio.side_effect = create_error
        backend = smoke.ModalBackend(); backend.modal = sdk; backend.app = object(); backend.client = object()
        return backend, sdk, vm

    async def test_pat_reaches_only_ephemeral_image_pull_secret_not_guest(self):
        dummy = 'synthetic-registry-password-not-a-real-token'
        backend, sdk, vm = self.setup_backend()
        environment = {'GH_CONTAINER_REGISTRY_TOKEN': dummy}
        with patch.object(smoke.os, 'environ', environment):
            await backend.create('mock')
        sdk.Secret.from_dict.assert_called_once_with({'REGISTRY_USERNAME': 'justsml', 'REGISTRY_PASSWORD': dummy})
        sdk.Image.from_registry.assert_called_once_with(smoke.IMAGE, secret=sdk.Secret.from_dict.return_value)
        kwargs = sdk.Sandbox.create.aio.call_args.kwargs
        self.assertIs(kwargs['image'], sdk.Image.from_registry.return_value)
        self.assertEqual(kwargs['secrets'], []); self.assertEqual(kwargs['env'], {})
        self.assertEqual(kwargs['volumes'], {}); self.assertFalse(kwargs['include_oidc_identity_token'])
        self.assertNotIn('GH_CONTAINER_REGISTRY_TOKEN', environment)
        await backend.write(b'only synthetic bytes', '/job/input')
        await backend.execute(['python3', '-I', '-c', 'pass'], 1, 16384)
        self.assertEqual(vm.exec.aio.call_args.kwargs['secrets'], [])
        self.assertEqual(vm.exec.aio.call_args.kwargs['env'], {})
        self.assertNotIn(dummy, repr(vm.exec.aio.call_args))
        self.assertNotIn(dummy, repr(vm.filesystem.write_bytes.aio.call_args))
        self.assertNotIn(dummy, json.dumps(smoke.LIMITS))

    async def test_absent_token_anonymous_and_empty_token_refuses_without_fallback(self):
        backend, sdk, _ = self.setup_backend()
        with patch.object(smoke.os, 'environ', {}): await backend.create('mock')
        sdk.Secret.from_dict.assert_not_called(); sdk.Image.from_registry.assert_called_once_with(smoke.IMAGE)
        backend, sdk, _ = self.setup_backend()
        with patch.object(smoke.os, 'environ', {'GH_CONTAINER_REGISTRY_TOKEN': ''}):
            with self.assertRaises(RuntimeError): await backend.create('mock')
        sdk.Image.from_registry.assert_not_called(); sdk.Sandbox.create.aio.assert_not_called()

    async def test_provider_token_diagnostics_and_error_never_reach_logs_or_receipts(self):
        dummy = 'synthetic-secret-diagnostic-not-real'
        async def denied(*args, **kwargs):
            print(dummy); print(dummy, file=sys.stderr); logging.warning(dummy)
            raise RuntimeError(dummy)
        backend, sdk, _ = self.setup_backend(denied)
        async def initialize(app): pass
        backend.initialize = initialize
        console, errors = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(smoke.os, 'environ', {'GH_CONTAINER_REGISTRY_TOKEN': dummy}), contextlib.redirect_stdout(console), contextlib.redirect_stderr(errors):
                state = await smoke.run_smoke(backend, root / 'output', root / 'attempt.lock', 'mock', cleanup_seconds=.02)
            self.assertEqual(state['errorClass'], 'RuntimeError')
            self.assertEqual(sdk.Sandbox.create.aio.call_count, 1)
            self.assertEqual(sdk.Image.from_registry.call_count, 1)
            for path in root.rglob('*'):
                if path.is_file(): self.assertNotIn(dummy.encode(), path.read_bytes())
        self.assertNotIn(dummy, console.getvalue()); self.assertNotIn(dummy, errors.getvalue())


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
