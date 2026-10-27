"""Trusted synthetic-only guest helpers. Executed inside the one QA VM only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sys

ROOT = Path('/opt/docslurp/layout')
JOB = Path('/job')


def main(operation):
    if operation == 'prepare':
        from PIL import Image
        Image.new('RGB', (4097, 1)).save(JOB / 'oversized.png')
        a = Image.new('RGB', (32, 32), 'white')
        a.save(JOB / 'animated.png', save_all=True, append_images=[Image.new('RGB', (32, 32), 'black')], duration=100)
        (JOB / 'malformed').write_bytes(b'synthetic invalid image')
        with (JOB / 'large').open('wb') as handle:
            for _ in range(25): handle.write(b'x' * (1024 * 1024))
            handle.write(b'x')
        shutil.copyfile(JOB / 'input', JOB / 'original.png')
        print(json.dumps({'preparedSyntheticCases': True}))
    elif operation == 'encode-stage':
        shutil.copyfile(JOB / 'original.png', JOB / 'input')
    elif operation == 'decode-stage':
        shutil.copyfile(JOB / 'output', JOB / 'input')
    elif operation == 'pixels':
        from PIL import Image
        with Image.open(JOB / 'original.png') as a, Image.open(JOB / 'output') as b:
            assert a.size == b.size and a.convert('RGB').tobytes() == b.convert('RGB').tobytes()
            print(json.dumps({'exactPixelRoundtrip': True, 'width': a.width, 'height': a.height,
                              'rgbSha256': hashlib.sha256(a.convert('RGB').tobytes()).hexdigest()}))
    elif operation.startswith('stage:'):
        name = operation.split(':')[1]
        if name not in ('malformed', 'oversized.png', 'animated.png', 'large'): raise ValueError('Invalid synthetic case')
        shutil.copyfile(JOB / name, JOB / 'input')
    elif operation == 'tamper-copy':
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        files = [ROOT / 'assets' / f['path'] for f in manifest['files']]
        assert sum(p.stat().st_size for p in files) <= 32 * 1024 * 1024
        target = JOB / 'tampered'
        target.mkdir(exist_ok=False)
        shutil.copytree(ROOT / 'assets', target / 'assets', symlinks=False)
        shutil.copyfile(ROOT / 'manifest.json', target / 'manifest.json')
        graph = target / 'assets/model.onnx'
        with graph.open('r+b') as handle:
            first = handle.read(1); handle.seek(0); handle.write(bytes([first[0] ^ 1]))
        print(json.dumps({'onlyJobCopyMutated': True}))
    elif operation == 'canonical':
        sys.path.insert(0, str(ROOT / 'runtime'))
        from asset_identity import verify_asset_bundle
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        print(json.dumps({'artifactSha256': verify_asset_bundle(ROOT / 'assets', manifest['files'])}))
    elif operation == 'network':
        try:
            connection = socket.create_connection(('1.1.1.1', 443), timeout=2)
        except OSError as error:
            print(json.dumps({'outboundConnectionFailed': True, 'errorClass': type(error).__name__, 'errno': error.errno}))
        else:
            connection.close(); raise AssertionError('Outbound connection unexpectedly succeeded')
    elif operation == 'resources':
        values = {}
        for name in ('cpu.max', 'memory.max', 'memory.swap.max', 'pids.max'):
            path = Path('/sys/fs/cgroup') / name
            values[name] = path.read_text().strip() if path.is_file() else None
        values['cpuAffinityCount'] = len(os.sched_getaffinity(0))
        print(json.dumps(values))
    else: raise ValueError('Unknown guest helper operation')


if __name__ == '__main__': main(sys.argv[1])
