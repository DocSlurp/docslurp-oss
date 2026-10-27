#!/usr/bin/env python3
"""One authorized QA VM; default plan mode never imports Modal or authenticates."""
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import signal
import time
import uuid
from datetime import datetime, timezone

IMAGE_DIGEST = 'sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21'
IMAGE = 'ghcr.io/docslurp/worker-document-vm@' + IMAGE_DIGEST
INDEX_DIGEST = 'sha256:fbbdd7f307ff8ccf49c3fd74e7fc448b5c4eda8878bfb1accf0920669b39b3ee'
BUNDLE = 'ccfa68bc3ae28999c172ed232b036dfc283801225c97949bf1f30186ea929e9d'
PROFILE = '402045d01939270ce7a497120f2c569d8bc42764d567b0b66ff311e66e485182'
REVISION = '8ac289e66575bb9bba6e15c53719d8b15cc9b3b2'
SOURCE_SHA = 'a8927b55a9cdc91a76bab7e4de92cd8bf3dbac955ecd7628b17442bed58a4c9c'
PROGRAM_SHA = 'f2d8515f5919bb437a2ea77f648750ea7b30420b381124312709733d79bad004'
REQUEST = {'model': 'pp-small-onnx', 'device': 'cpu', 'modelId': 'PaddlePaddle/PP-DocLayout-S',
           'revision': REVISION, 'artifactSha256': BUNDLE, 'inferenceProfileSha256': PROFILE}
PROVIDER_SECONDS = 1800
HOST_SECONDS = 1800
CLEANUP_SECONDS = 30
PER_COMMAND_SECONDS = 55
LIMITS = {'runtime': 'vm', 'cpu': (2, 2), 'memory': (1024, 1024), 'timeout': PROVIDER_SECONDS,
          'block_network': True, 'include_oidc_identity_token': False, 'env': {}, 'secrets': [],
          'volumes': {}, 'network_file_systems': {}, 'gpu': None}
ROOT = Path(__file__).resolve().parents[2]
QA = ROOT / 'docs/qa/2026-10-27-document-vm-image'
ENV = ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/job', 'TMPDIR=/job',
       'PYTHONNOUSERSITE=1', 'CUDA_VISIBLE_DEVICES=', 'HF_HUB_OFFLINE=1', 'PYTHONDONTWRITEBYTECODE=1']
READ_OUTPUT = """
import os,stat,sys
fd=os.open('/job/output',os.O_RDONLY|os.O_NOFOLLOW)
info=os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or not 0<info.st_size<=10485760: raise ValueError('Invalid declared layout output')
remaining=10485761
while remaining:
 chunk=os.read(fd,min(65536,remaining))
 if not chunk: break
 sys.stdout.buffer.write(chunk);remaining-=len(chunk)
"""


def now(): return datetime.now(timezone.utc).isoformat()


def bundle_sha():
    files = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
             for name in ('modal_smoke.py', 'guest_smoke.py')}
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def assets():
    data = (QA / 'synthetic.png').read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA: raise ValueError('Synthetic input identity changed')
    source = (ROOT / 'worker/src/sandbox/providers/modal/document-vm.ts').read_text()
    program = re.search(r'export const IMAGE_PROGRAM = `\n(.*?)`;', source, re.S).group(1)
    if hashlib.sha256(program.encode()).hexdigest() != PROGRAM_SHA: raise ValueError('Reviewed IMAGE_PROGRAM changed')
    return data, program


def validate_reviews(path):
    record = json.loads(Path(path).read_text())
    reviewers = record.get('reviewers', [])
    if record.get('runnerBundleSha256') != bundle_sha() or record.get('imageDigest') != IMAGE_DIGEST:
        raise ValueError('Reviews do not cover these runner files and image')
    if len(reviewers) < 2 or len({r.get('id') for r in reviewers}) != len(reviewers) or any(not r.get('id') or r.get('decision') != 'approved' for r in reviewers):
        raise ValueError('Two independent approving reviewers are required')
    if not any(r.get('adversarial') is True for r in reviewers):
        raise ValueError('At least one approving reviewer must be adversarial')
    return record


async def bounded_stream(stream, maximum):
    output = bytearray()
    async for part in stream:
        if not isinstance(part, bytes): raise ValueError('Binary guest stream required')
        if len(output) + len(part) > maximum: raise ValueError('Guest stream limit exceeded')
        output.extend(part)
    return bytes(output)


class ModalBackend:
    """Python 1.6.2 public SDK, using CLI-profile Client.from_env only on execute."""
    async def initialize(self, app):
        if importlib.metadata.version('modal') != '1.6.2': raise ValueError('Modal SDK 1.6.2 is required')
        import modal
        self.modal = modal
        self.client = await modal.Client.from_env.aio()
        # No App.run/deploy or create_if_missing: coordinator supplies an existing app.
        self.app = await modal.App.lookup.aio(app, client=self.client, create_if_missing=False)

    async def create(self, run_id):
        self.vm = await self.modal.Sandbox.create.aio(
            *ENV, 'python3', '-I', '-c', 'import time; time.sleep(1800)',
            app=self.app, image=self.modal.Image.from_registry(IMAGE),
            name='document-vm-smoke-' + run_id, tags={'docslurp-qa-run': run_id},
            client=self.client, **LIMITS)
        return self.vm.object_id

    async def write(self, data, path):
        await self.vm.filesystem.make_directory.aio('/job', create_parents=True)
        await self.vm.filesystem.write_bytes.aio(data, path)

    async def execute(self, command, seconds, stdout_limit):
        child = await self.vm.exec.aio(*ENV, *command, timeout=seconds, text=False, secrets=[], env={})
        out, err, code = await asyncio.gather(bounded_stream(child.stdout, stdout_limit),
                                            bounded_stream(child.stderr, 16384), child.wait.aio())
        return out, err, code

    async def terminate(self): await self.vm.terminate.aio(wait=False)
    async def poll(self): return await self.vm.poll.aio()


async def run_smoke(backend, output, attempt_lock, app, *, work_seconds=HOST_SECONDS, cleanup_seconds=CLEANUP_SECONDS):
    """Dependency-injected control loop. No recreation on any failure or ambiguity."""
    data, image_program = assets()
    output, attempt_lock = Path(output), Path(attempt_lock)
    output.mkdir(parents=True, exist_ok=False)
    attempt_lock.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(attempt_lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    run_id = uuid.uuid4().hex
    with os.fdopen(fd, 'w') as handle:
        json.dump({'runId': run_id, 'output': str(output.resolve()), 'consumedAt': now()}, handle)
        handle.flush(); os.fsync(handle.fileno())
    started = time.monotonic(); deadline = started + work_seconds
    state = {'runId': run_id, 'runnerBundleSha256': bundle_sha(), 'image': IMAGE, 'indexDigest': INDEX_DIGEST,
             'request': REQUEST, 'syntheticSourceSha256': SOURCE_SHA, 'startedAt': now(), 'limits': LIMITS,
             'authorization': {'aggregateCapUsd': 20, 'maximumVms': 1, 'expirySeconds': PROVIDER_SECONDS,
                               'retries': 0, 'deploy': False, 'sharedSpendLimitInvestigationWaived': True},
             'sandboxId': None, 'createInvocations': 0, 'checks': [], 'termination': {'verified': False},
             'providerUsage': {'billedUsd': None, 'status': 'Per-sandbox billing unavailable in public SDK; coordinator reconciliation required'},
             'status': 'starting'}
    def save():
        temp = output / 'state.pending'
        temp.write_text(json.dumps(state, indent=2) + '\n'); temp.replace(output / 'state.json')
    save()
    pending_tasks = set()
    async def control(awaitable, maximum=None):
        remaining = min(deadline - time.monotonic(), maximum if maximum is not None else work_seconds)
        if remaining <= 0:
            if hasattr(awaitable, 'close'): awaitable.close()
            raise TimeoutError('Host deadline')
        task = asyncio.create_task(awaitable); pending_tasks.add(task)
        done, _ = await asyncio.wait({task}, timeout=remaining)
        if not done:
            # Keep create alive briefly to recover a late ID; never call create again.
            raise TimeoutError('Bounded control deadline')
        pending_tasks.discard(task)
        return task.result()
    async def execute(name, command, *, expected_error=None, stdout_limit=16384):
        before = now(); began = time.monotonic()
        seconds = min(PER_COMMAND_SECONDS, max(1, math.ceil(deadline - time.monotonic())))
        out, err, code = await control(backend.execute(command, seconds, stdout_limit), seconds + 2)
        record = {'name': name, 'startedAt': before, 'completedAt': now(), 'seconds': time.monotonic() - began,
                  'exitCode': code, 'stdoutBytes': len(out), 'stderrBytes': len(err)}
        (output / (name + '.stderr.txt')).write_bytes(err)
        state['checks'].append(record); save()
        if expected_error is None:
            if code != 0: raise ValueError('Guest case failed: ' + name)
        elif code == 0 or expected_error.encode() not in err:
            raise ValueError('Expected precise refusal absent: ' + name)
        return out
    helper = lambda action: ['python3', '-I', '/job/guest_smoke.py', action]
    entry = lambda request: ['python3', '-P', '/opt/docslurp/layout/runtime/vm_entry.py', json.dumps(request)]
    creation = None
    try:
        await control(backend.initialize(app))
        async def create():
            if time.monotonic() >= deadline: raise TimeoutError('Host deadline before create')
            state['createInvocations'] = 1; state['createRequestedAt'] = now(); save()
            identifier = await backend.create(run_id)
            state['sandboxId'] = identifier; state['createReturnedAt'] = now(); save()
            return identifier
        creation = asyncio.create_task(create())
        done, _ = await asyncio.wait({creation}, timeout=max(0, deadline - time.monotonic()))
        if not done: raise TimeoutError('Creation response deadline')
        creation.result()
        await control(backend.write(data, '/job/input'))
        await control(backend.write(Path(__file__).with_name('guest_smoke.py').read_bytes(), '/job/guest_smoke.py'))
        await execute('prepare', helper('prepare'))
        canonical = json.loads(await execute('canonical-before', helper('canonical')))
        if canonical.get('artifactSha256') != BUNDLE: raise ValueError('Canonical bundle mismatch')
        await execute('layout', entry(REQUEST))
        out = await execute('layout-output', ['python3', '-I', '-c', READ_OUTPUT], stdout_limit=10 * 1024 * 1024)
        result = json.loads(out)
        if result.get('image') != {'width': 800, 'height': 1000, 'sha256': SOURCE_SHA}: raise ValueError('Layout source identity mismatch')
        if result.get('model') != {'id': REQUEST['modelId'], 'revision': REVISION, 'artifactSha256': BUNDLE} or result.get('inferenceProfileSha256') != PROFILE or result.get('device') != 'cpu':
            raise ValueError('Layout model/profile mismatch')
        (output / 'layout.json').write_bytes(out)
        await execute('encode-stage', helper('encode-stage'))
        await execute('encode-webp', ['python3', '-I', '-c', image_program, 'encode-webp', '1'])
        await execute('decode-stage', helper('decode-stage'))
        await execute('decode-webp', ['python3', '-I', '-c', image_program, 'decode-webp', '1'])
        pixels = json.loads(await execute('pixel-roundtrip', helper('pixels')))
        if pixels.get('exactPixelRoundtrip') is not True: raise ValueError('Pixel roundtrip mismatch')
        (output / 'pixel-roundtrip.json').write_text(json.dumps(pixels, indent=2) + '\n')
        for key in ('modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256'):
            bad = {k: v for k, v in REQUEST.items() if k != key}
            await execute('missing-' + key, entry(bad), expected_error='Missing required request identity')
            bad = {**REQUEST, key: '0' * 64 if key.endswith('Sha256') else 'wrong'}
            await execute('wrong-' + key, entry(bad), expected_error='Model manifest identity mismatch')
        await execute('wrong-model', entry({**REQUEST, 'model': 'heron'}), expected_error='Unsupported model in this VM image')
        await execute('wrong-device', entry({**REQUEST, 'device': 'cuda'}), expected_error='CUDA is unavailable behind the VM boundary')
        for name, reason in [('malformed', 'cannot identify image file'), ('oversized.png', 'Invalid image dimensions'),
                             ('animated.png', 'Invalid image dimensions'), ('large', 'Oversized layout input')]:
            await execute('stage-' + name, helper('stage:' + name))
            await execute('reject-' + name, entry(REQUEST), expected_error=reason)
            if name != 'large':
                image_reason = 'cannot identify image file' if name == 'malformed' else 'unsupported image dimensions or animation'
                await execute('image-reject-' + name, ['python3', '-I', '-c', image_program, 'encode-webp', '1'], expected_error=image_reason)
        await execute('restore-synthetic', helper('encode-stage'))
        await execute('tamper-copy', helper('tamper-copy'))
        tamper = ['python3', '-P', '-c', "import sys;from pathlib import Path;sys.path.insert(0,'/opt/docslurp/layout/runtime');import vm_entry;vm_entry.main(__import__('json').loads(sys.argv[1]),root=Path('/job/tampered'))", json.dumps(REQUEST)]
        await execute('tampered-copy-refused', tamper, expected_error='Offline model asset hash mismatch')
        if json.loads(await execute('canonical-after', helper('canonical'))).get('artifactSha256') != BUNDLE:
            raise ValueError('Canonical assets changed')
        network = json.loads(await execute('blocked-network', helper('network')))
        if network.get('outboundConnectionFailed') is not True: raise ValueError('Network probe mismatch')
        (output / 'network.json').write_text(json.dumps(network, indent=2) + '\n')
        (output / 'guest-resources.json').write_bytes(await execute('resources', helper('resources')))
        state['status'] = 'checks-passed'
    except BaseException as error:
        state['status'] = 'failed'; state['errorClass'] = type(error).__name__
        # No raw provider exceptions, auth config or traceback in evidence.
    finally:
        state['workFinishedAt'] = now(); save()
        cleanup_deadline = time.monotonic() + cleanup_seconds
        try:
            if creation and not creation.done():
                await asyncio.wait({creation}, timeout=max(0, cleanup_deadline - time.monotonic()) / 3)
            if state['sandboxId']:
                await asyncio.wait_for(backend.terminate(), timeout=max(.001, (cleanup_deadline - time.monotonic()) / 2))
                state['termination']['requestedAt'] = now()
                while time.monotonic() < cleanup_deadline:
                    code = await asyncio.wait_for(backend.poll(), timeout=max(.001, cleanup_deadline - time.monotonic()))
                    if code is not None:
                        state['termination'].update(verified=True, verifiedAt=now(), providerReturnCode=code); break
                    await asyncio.sleep(min(.2, max(0, cleanup_deadline - time.monotonic())))
            elif state['createInvocations']:
                state['termination']['creationUncertain'] = creation is not None and not creation.done()
        except BaseException as error:
            state['termination']['errorClass'] = type(error).__name__
        for task in pending_tasks | ({creation} if creation is not None else set()):
            if not task.done(): task.cancel()
            task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
        state['completedAt'] = now(); state['elapsedHostSeconds'] = time.monotonic() - started
        state['computeEstimateOnlyUsd'] = min(PROVIDER_SECONDS, state['elapsedHostSeconds']) * .00008551
        state['computeAllocationCeilingUsdExcludingImportStorageNetwork'] = PROVIDER_SECONDS * .00008551
        if not state['termination']['verified'] and state['createInvocations']:
            state['status'] = 'cleanup-unverified-no-retry'
        save()
    return state


def plan():
    assets()
    return {'mode': 'plan-only-no-sdk-import', 'runnerBundleSha256': bundle_sha(), 'image': IMAGE, 'indexDigest': INDEX_DIGEST,
            'request': REQUEST, 'limits': LIMITS, 'hostWorkDeadlineSeconds': HOST_SECONDS,
            'cleanupReserveSeconds': CLEANUP_SECONDS, 'aggregateAuthorizationUsd': 20, 'retries': 0,
            'requiredReviews': 2, 'productionExecutorSecondsUnchanged': 60,
            'providerUsage': 'Per-sandbox billed usage unavailable in public SDK1.6.2; reconcile by captured ID/time, not shared account spend'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--app', help='Existing coordinator-approved App; never created/deployed by runner')
    parser.add_argument('--reviews', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--attempt-lock', type=Path, default=ROOT / '.cache/document-vm-image/modal-smoke-attempt.lock')
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps(plan(), indent=2)); return 0
    if not args.app or not args.reviews or not args.output: parser.error('--execute requires --app, --reviews and --output')
    validate_reviews(args.reviews)
    # Independent provider 1800s expiry remains in force if host is killed. An OS
    # alarm additionally bounds an uncooperative SDK/event-loop beyond cleanup.
    signal.alarm(HOST_SECONDS + CLEANUP_SECONDS + 10)
    try:
        state = asyncio.run(run_smoke(ModalBackend(), args.output, args.attempt_lock, args.app))
        return 0 if state['status'] == 'checks-passed' and state['termination']['verified'] else 1
    except BaseException:
        print('One-shot smoke refused or failed; inspect sanitized state evidence. No automatic retry.')
        return 1
    finally: signal.alarm(0)


if __name__ == '__main__': raise SystemExit(main())
