#!/usr/bin/env python3
"""Exercise the actual guest programs offline. This proves packaging, not VM isolation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
from container_case import run_container

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True)
parser.add_argument('--job', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.job.mkdir(parents=True, exist_ok=False)
args.job.chmod(0o777)
args.evidence.mkdir(parents=True, exist_ok=True)
repo = Path(__file__).resolve().parents[2]
source = (repo / 'worker/src/sandbox/providers/modal/document-vm.ts').read_text()
program = re.search(r'export const IMAGE_PROGRAM = `\n(.*?)`;', source, re.S).group(1)
base = ['docker', 'run', '--rm', '--network=none', '--cpus=2', '--memory=1g', '--memory-swap=1g',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
        f'--user={os.getuid()}:{os.getgid()}', '-v', f'{args.job.resolve()}:/job', args.image]
if os.getuid() == 0: raise ValueError('Run validation as an unprivileged host user')
records = []

def stage(data):
    path = args.job / 'input'
    path.unlink(missing_ok=True)
    path.write_bytes(data)
    path.chmod(0o666)

def run(name, command, success=True):
    started = time.monotonic()
    p, container_name = run_container(base, command)
    record = {'name': name, 'exitCode': p.returncode, 'seconds': time.monotonic() - started,
              'stdoutBytes': len(p.stdout), 'stderrBytes': len(p.stderr), 'expectedSuccess': success,
              'containerName': container_name, 'daemonContainerCleanupConfirmed': True}
    (args.evidence / (name + '.stderr.txt')).write_bytes(p.stderr)
    records.append(record)
    if (p.returncode == 0) != success:
        raise AssertionError(f'{name}: unexpected exit {p.returncode}: {p.stderr[-2000:]!r}')
    if success and len(p.stderr) > 16384:
        raise AssertionError(f'{name}: actual executor stderr cap exceeded: {len(p.stderr)}')
    return p.stdout

try:
    manifest = json.loads(run('manifest', ['cat', '/opt/docslurp/layout/manifest.json']))
    (args.evidence / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    run('synthetic', ['python3', '-I', '-c', '''from PIL import Image, ImageDraw
from pathlib import Path
im=Image.new('RGB',(800,1000),'white'); d=ImageDraw.Draw(im)
d.text((60,45),'SYNTHETIC PACKAGING TEST',fill='black')
for y in range(100,400,24): d.rectangle((60,y,660,y+5),fill='black')
d.rectangle((60,470,380,720),outline='black',width=3)
for x in range(60,381,80): d.line((x,470,x,720),fill='black')
for y in range(470,721,50): d.line((60,y,380,y),fill='black')
im.save('/job/input',format='PNG'); im.save('/job/synthetic.png')
Image.new('RGB',(4097,1)).save('/job/oversized.png')
im.save('/job/animated.png',save_all=True,append_images=[Image.new('RGB',im.size,'black')],duration=100)
Path('/job/malformed').write_bytes(b'hostile invalid image')
'''])
    png = (args.job / 'input').read_bytes()
    (args.evidence / 'synthetic.png').write_bytes(png)
    run('encode-webp', ['python3', '-I', '-c', program, 'encode-webp', '1'])
    webp = (args.job / 'output').read_bytes()
    stage(webp)
    run('decode-webp', ['python3', '-I', '-c', program, 'decode-webp', '1'])
    run('roundtrip-pixels', ['python3', '-I', '-c', "from PIL import Image; assert Image.open('/job/output').tobytes()==Image.open('/job/synthetic.png').tobytes()"])
    request = {k: manifest[k] for k in ('model', 'modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256')}
    request['device'] = 'cpu'
    entry = ['python3', '-P', '/opt/docslurp/layout/runtime/vm_entry.py']
    stage(png)
    run('layout', entry + [json.dumps(request)])
    result = json.loads((args.job / 'output').read_text())
    assert result['image']['sha256'] == hashlib.sha256(png).hexdigest()
    assert result['inferenceProfileSha256'] == manifest['inferenceProfileSha256']
    assert result['model']['artifactSha256'] == manifest['artifactSha256']
    (args.evidence / 'layout.json').write_text(json.dumps(result, indent=2) + '\n')
    for key in ('model', 'modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256', 'device'):
        bad = {**request, key: '0' * 64 if key.endswith('Sha256') else 'wrong-identity'}
        run('wrong-' + key, entry + [json.dumps(bad)], False)
    for key in ('modelId', 'revision', 'artifactSha256', 'inferenceProfileSha256'):
        bad = {k: v for k, v in request.items() if k != key}
        run('missing-' + key, entry + [json.dumps(bad)], False)
    tamper = args.job / 'tampered.onnx'
    tamper.write_bytes(b'not the declared model graph')
    base[-1:-1] = ['-v', f'{tamper.resolve()}:/opt/docslurp/layout/assets/model.onnx:ro']
    try:
        run('tampered-model-asset', entry + [json.dumps(request)], False)
    finally:
        del base[-3:-1]
    for name in ('malformed', 'oversized.png', 'animated.png'):
        stage((args.job / name).read_bytes())
        run('image-reject-' + name, ['python3', '-I', '-c', program, 'encode-webp', '1'], False)
        run('layout-reject-' + name, entry + [json.dumps(request)], False)
    (args.job / 'large').write_bytes(b'X' * (25 * 1024 * 1024 + 1))
    stage((args.job / 'large').read_bytes())
    run('layout-reject-bytes', entry + [json.dumps(request)], False)
    run('readonly', ['python3', '-I', '-c', "from pathlib import Path; Path('/opt/docslurp/should-fail').write_text('x')"], False)
    run('network', ['python3', '-I', '-c', "import socket; socket.create_connection(('1.1.1.1',443),timeout=2)"], False)
    limits = run('limits', ['python3', '-I', '-c', "from pathlib import Path; import json; print(json.dumps({p:Path('/sys/fs/cgroup/'+p).read_text().strip() for p in ['cpu.max','memory.max','memory.swap.max','pids.max']}))"])
    (args.evidence / 'container-limits.json').write_bytes(limits)
    # Local cancellation/cleanup only; does not test Modal control-plane behavior.
    name = 'docslurp-image-cancel-' + uuid.uuid4().hex
    child = subprocess.Popen(base[:-1] + ['--name', name, args.image, 'python3', '-I', '-c', 'import time; time.sleep(60)'],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    started = time.monotonic()
    try:
        for _ in range(50):
            state = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', name], capture_output=True)
            if state.stdout.strip() == b'true': break
            time.sleep(.1)
        else: raise AssertionError('Cancellation test container never started')
        subprocess.run(['docker', 'kill', name], check=True, capture_output=True, timeout=5)
        child.communicate(timeout=5)
        assert child.returncode != 0
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=5)
        if child.poll() is None: child.kill(); child.communicate(timeout=5)
    assert subprocess.run(['docker', 'inspect', name], capture_output=True).returncode != 0
    records.append({'name': 'local-cancel-and-remove', 'exitCode': child.returncode, 'seconds': time.monotonic() - started,
                    'containerAbsentAfterCleanup': True, 'scope': 'local Docker only, not Modal cancellation proof'})
finally:
    (args.evidence / 'validation.json').write_text(json.dumps({'scope': 'local container packaging only; no production VM proof', 'image': args.image,
        'actualImageProgramSha256': hashlib.sha256(program.encode()).hexdigest(), 'commandPrefix': base, 'checks': records}, indent=2) + '\n')
