"""Source-blind a6 input boundary and immutable artifacts.

No repository-relative generator imports, implicit fallbacks, or network calls.
The caller supplies the clean handoff and an external output directory.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import unicodedata

CODE = Path(__file__).resolve().parent
HANDOFF = Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a6-clean-r3')
SCRATCH = Path('/home/dan/tmp/agents')
for key in ('TMPDIR', 'TMP', 'TEMP'):
    os.environ[key] = str(SCRATCH)
os.environ.setdefault('MPLCONFIGDIR', str(SCRATCH / 'fools-gold-a6.dFM9qD' / 'matplotlib'))
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    def nfc(v):
        if isinstance(v, str): return unicodedata.normalize('NFC', v)
        if isinstance(v, list): return [nfc(x) for x in v]
        if isinstance(v, dict): return {nfc(k): nfc(x) for k, x in v.items()}
        return v
    return json.dumps(nfc(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return sha(value if isinstance(value, bytes) else canonical(value))


def freeze(value, field):
    assert field not in value
    return dict(value, **{field: digest(value)})


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = value if isinstance(value, bytes) else canonical(value) + b'\n'
    if path.exists():
        assert path.read_bytes() == data, f'Immutable artifact already differs: {path}'
    else:
        with path.open('xb') as f: f.write(data)


def verified_inputs():
    allow = json.loads((HANDOFF / 'allowlist.json').read_bytes())
    assert allow['schema'] == 'clean-builder-handoff@1' and allow['attempt'] == 6
    expected = {'spec-a6.md', 'spec-a6.json', 'requirements.lock.txt', 'README.md',
                *('generic/' + n + '.py' for n in ('support', 'math_layout', 'native_geometry', 'outlines', 'native_stream', 'editable_tables'))}
    assert set(allow['files']) == expected
    receipt = {}
    for name, want in allow['files'].items():
        p = HANDOFF / name
        assert p.resolve().is_relative_to(HANDOFF.resolve())
        got = sha(p.read_bytes())
        if got != want: raise ValueError(f'Input hash mismatch: {name}')
        receipt[name] = got
    return json.loads((HANDOFF / 'spec-a6.json').read_bytes()), receipt


SPEC, INPUT_HASHES = verified_inputs()
# Explicit approved generic directory only. It is reverified on every entry.
sys.path.insert(0, str(HANDOFF / 'generic'))
from support import FONTS, contains, union, intersect, area, iou, split_lines, words, normalized, paint_order


def tool_receipt():
    packages = ['Pillow', 'PyMuPDF', 'fonttools', 'jsonschema', 'matplotlib', 'numpy', 'pikepdf', 'reportlab']
    return dict(inputs=INPUT_HASHES, python=sys.version,
        packages={p: importlib.metadata.version(p) for p in packages},
        libreoffice=subprocess.check_output(['soffice', '--version'], text=True).strip(),
        fonts={k: dict(path=str(f.path), sha256=f.hash, upem=f.upem,
                       names=sorted({str(n.toUnicode()) for n in f.tt['name'].names if n.nameID in (1, 2, 5, 6)}))
               for k, f in FONTS.items()},
        networkCalls=0, paidCalls=0, delegatedTasks=0,
        dependencyPolicy='Only a6 code, hash-verified allowed generic helpers, and installed ordinary packages')


def family_plan():
    allowed = set(range(1, 18)) - {6, 12}
    plan = [p for p in SPEC['dataset']['family_plan'] if p['familyId'] in allowed]
    assert len(plan) == 15 and all(p['split'] == 'train' and p['classId'] != 'P' for p in plan)
    assert len({(p['classId'], p['layoutId']) for p in plan}) == 15
    return plan


def layout(family):
    return SPEC['enriched_derivatives'][family['classId']]['layouts'][family['layoutId']]


def numeric_parser(text):
    """Exact-decimal parser: source segments, never float -> decimal conversion."""
    import ast
    def parse_expr(src):
        def visit(node):
            if isinstance(node, ast.Name): return dict(op='symbol', name=node.id)
            if isinstance(node, ast.Constant) and type(node.value) in (int, float):
                literal = ast.get_source_segment(src, node)
                from decimal import Decimal
                from fractions import Fraction
                assert Fraction(literal) == Fraction(Decimal(literal))
                return dict(op='constant', valueDecimal=format(Decimal(literal), 'f'))
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
                child = visit(node.operand)
                assert child['op'] == 'constant'
                child['valueDecimal'] = '-' + child['valueDecimal']
                return child
            if isinstance(node, ast.BinOp):
                op = {ast.Add: 'add', ast.Sub: 'subtract', ast.Mult: 'multiply', ast.Div: 'divide', ast.Pow: 'power'}[type(node.op)]
                return dict(op=op, args=[visit(node.left), visit(node.right)])
            raise ValueError('Unsupported AST')
        return visit(ast.parse(src, mode='eval').body)
    left, right = text.split('=')
    return dict(op='equal', args=[parse_expr(left.strip()), parse_expr(right.strip().replace('^', '**'))])
