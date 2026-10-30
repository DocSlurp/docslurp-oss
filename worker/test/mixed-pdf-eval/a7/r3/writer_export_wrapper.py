"""Prospective Writer outer wrapper; NOT an R2 migration or retrospective receipt.
Integrator invokes against a NEW frozen round and an already isolated UNO process.
No process is started here except system Python. ReportLab path stays independent.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback
import uuid
from export_binding import identity, unchanged, require, now, write_json, verify_receipt

ROOT = Path(__file__).resolve().parent
FROZEN_R2 = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round2')

def converter_state(pid, pipe):
    proc = Path('/proc')/str(int(pid))
    executable = (proc/'exe').resolve(strict=True)
    require(executable.name == 'soffice.bin', 'Attached process is not soffice.bin')
    argv = (proc/'cmdline').read_bytes().split(b'\0')
    expected = ('--accept=pipe,name='+pipe+';urp;StarOffice.ServiceManager').encode()
    require(expected in argv, 'Converter PID does not own requested pipe argument')
    # Field 22, after comm (which can contain spaces or parentheses).
    start_ticks = (proc/'stat').read_text().rsplit(')', 1)[1].split()[19]
    return {'pid': int(pid), 'startTicks': start_ticks, 'executable': str(executable),
            'argv': [a.decode('utf-8', 'strict') for a in argv if a]}

def frozen_identities(freeze_path):
    freeze_path = Path(freeze_path).resolve(strict=True)
    data = json.loads(freeze_path.read_bytes())
    result = {'freeze': identity(freeze_path)}
    for name, expected in data['files'].items():
        path = (freeze_path.parent/name).absolute()
        require(path.is_relative_to(freeze_path.parent) and '..' not in Path(name).parts, 'Unsafe frozen path')
        item = identity(path)
        require(item['sha256'] == expected, 'Freeze mismatch: '+name)
        result[name] = item
    return result

def export_writer(plan_path, directory, freeze_path, pipe, converter_pid, *, runner=subprocess.run):
    directory = Path(directory).resolve(strict=True)
    require(not directory.is_relative_to(FROZEN_R2), 'Never bind or modify frozen R2')
    plan_path = Path(plan_path).resolve(strict=True)
    freeze = frozen_identities(freeze_path)
    require(any(item['path'] == str(plan_path) for item in freeze.values()), 'Plan not listed in freeze')
    plan = json.loads(plan_path.read_bytes())
    stem = plan['stem']
    require(stem and Path(stem).name == stem and stem not in ('.', '..'), 'Unsafe stem')
    outer_path = directory/(stem+'.execution.json')
    context_path = directory/(stem+'.writer-launch.json')
    for suffix in ('.execution.json', '.writer-launch.json', '.artifact-receipt.json', '.stdout.txt', '.stderr.txt', '.odt', '.pdf',
                   '.readback-before.json', '.readback-reloaded.json', '.readback-after-export.json'):
        target = directory/(stem+suffix)
        require(not target.exists() and not target.is_symlink(), 'Refusing old output: '+str(target))
    execution_id = str(uuid.uuid4())
    receipt = {'schema': 'writer-outer-execution@1', 'executionId': execution_id,
               'startedAtUtc': now(), 'status': 'started', 'freeze': freeze,
               'wrapper': identity(__file__), 'plan': identity(plan_path)}
    try:
        converter = converter_state(converter_pid, pipe)
        python = str(Path('/usr/bin/python3').resolve(strict=True))
        # UNO is probed in its system ABI; this imports modules but performs no conversion.
        probe = runner([python, '-B', '-c', 'import json,uno,importlib.util; print(json.dumps({"uno":uno.__file__,"pyuno":importlib.util.find_spec("pyuno").origin}))'],
                       capture_output=True, text=True, timeout=15, check=True)
        module_paths = json.loads(probe.stdout)
        paths = {'writer': ROOT/'writer_native.py', 'binding': ROOT/'export_binding.py', 'widthReadback':ROOT/'width_readback.py',
                 'keeper':ROOT/'keeper_connection.py','wrapper': Path(__file__),
                 'python': Path(python), 'converter': Path(converter['executable']),
                 **{k: Path(v).resolve(strict=True) for k, v in module_paths.items()}}
        tools = {role: identity(path) for role, path in paths.items()}
        command = [python, '-B', str(ROOT/'writer_native.py'), pipe, str(plan_path), str(directory), str(context_path)]
        context = {'executionId': execution_id, 'pipe': pipe, 'converter': converter, 'tools': tools,
                   'wrapperPid': os.getpid(), 'command': command, 'startedAtUtc': now()}
        write_json(context_path, context)
        expected_tools = {**tools, 'context': identity(context_path)}
        receipt['launch'] = context
        result = runner(command, capture_output=True, text=True, timeout=120, check=False,
                        env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'TMPDIR': '/home/dan/tmp/agents',
                             'TMP': '/home/dan/tmp/agents', 'TEMP': '/home/dan/tmp/agents'})
        write_json(directory/(stem+'.stdout.txt'), {'stdout': result.stdout})
        write_json(directory/(stem+'.stderr.txt'), {'stderr': result.stderr})
        receipt['exitCode'] = result.returncode
        require(result.returncode == 0, 'Writer execution failed')
        require(converter_state(converter_pid, pipe) == converter, 'Converter process changed')
        for item in freeze.values():
            unchanged(item)
        unchanged(receipt['wrapper'])
        receipt['checkedArtifactReceipt'] = verify_receipt(directory/(stem+'.artifact-receipt.json'), plan_path, execution_id, expected_tools)
        receipt['status'] = 'exported-with-checked-binding'
    except Exception:
        receipt['status'] = 'failed'
        receipt['error'] = traceback.format_exc()
        candidate = directory/(stem+'.artifact-receipt.json')
        if candidate.exists():
            receipt['unverifiedArtifactReceiptIdentity'] = identity(candidate)
        raise
    finally:
        receipt['finishedAtUtc'] = now()
        write_json(outer_path, receipt)
    return receipt

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--freeze', required=True)
    parser.add_argument('--pipe', required=True)
    parser.add_argument('--converter-pid', required=True, type=int)
    args = parser.parse_args()
    export_writer(args.plan, args.output, args.freeze, args.pipe, args.converter_pid)

if __name__ == '__main__':
    main()
