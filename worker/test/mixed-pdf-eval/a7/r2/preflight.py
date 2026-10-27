"""Source-blind attempt 7 runtime verification; no candidate authoring."""
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

HANDOFF = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a7-clean-r2')
OUTPUT = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round2')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def main():
    runtime = json.loads((HANDOFF / 'runtime.json').read_text())
    allowlist = json.loads((HANDOFF / 'allowlist.json').read_text())
    receipt = {'observedAtUtc': datetime.now(timezone.utc).isoformat(), 'phase': 'pre-authoring',
               'python': sys.version, 'interpreter': sys.executable, 'files': {}, 'packages': {}, 'tools': {}, 'fonts': {},
               'treeHashAlgorithm': 'SHA256(json.dumps(sorted RECORD-path -> SHA256(file) mapping, sort_keys=True)); exclude pyc; include installed metadata',
               'rendererConfiguration': {'paperPt': [612, 792], 'pdfVersion': '1.7', 'previewDpi': 150, 'inspectionDpi': 300,
                                         'nativeProducerRuns': 'one sequential isolated Writer process; ReportLab independent',
                                         'network': False, 'maximumLocalWorkers': 3}}
    assert len(allowlist['files']) == 11
    for name, expected in allowlist['files'].items():
        actual = digest(HANDOFF / name)
        receipt['files'][name] = {'sha256': actual, 'match': actual == expected}
        assert actual == expected, name
    assert sys.executable == runtime['interpreter'] and sys.version == runtime['python']
    assert digest(sys.executable) == runtime['interpreterHash']
    for name, expected in runtime['packages'].items():
        dist = metadata.distribution(name)
        files = dict(sorted((str(f), digest(dist.locate_file(f))) for f in dist.files
                            if Path(dist.locate_file(f)).is_file() and not str(f).endswith('.pyc')))
        actual = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
        receipt['packages'][name] = {'version': dist.version, 'treeHash': actual, 'files': files,
                                      'match': dist.version == expected['version'] and actual == expected['treeHash']}
        assert receipt['packages'][name]['match'], name
    for name, expected in runtime['binaries'].items():
        receipt['tools'][name] = {'path': expected['path'], 'sha256': digest(expected['path'])}
        assert receipt['tools'][name]['sha256'] == expected['sha256'], name
    from fontTools.ttLib import TTFont
    for name, expected in runtime['fonts'].items():
        font = TTFont(expected['path'])
        receipt['fonts'][name] = {**expected, 'actualSha256': digest(expected['path']), 'actualUnitsPerEm': font['head'].unitsPerEm,
                                  'nameRecords': [str(n.toUnicode()) for n in font['name'].names if n.nameID in (1, 2, 5, 6)]}
        assert receipt['fonts'][name]['actualSha256'] == expected['sha256']
        assert font['head'].unitsPerEm == expected['unitsPerEm']
    receipt['libreofficeVersion'] = subprocess.check_output(['/usr/bin/soffice', '--version'], text=True).strip()
    receipt['additionalSystemRuntime'] = {p: digest(p) for p in ['/usr/lib/libreoffice/program/soffice.bin',
                                                              '/usr/lib/python3.14/site-packages/uno.py']}
    receipt['mismatches'] = []
    target = OUTPUT / 'runtime-source-receipt.json'
    assert not target.exists()
    target.write_text(json.dumps(receipt, indent=2) + '\n')
    print('Verified 11 handoff files, 32 installed package versions and trees, all binaries and both fonts.')

if __name__ == '__main__':
    main()
