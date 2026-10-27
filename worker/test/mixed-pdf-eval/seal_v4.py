"""Create an immutable evaluation view of an independently approved v4 corpus.

Inventory and approval checks precede label access, including for heldout families.
The original generation tree remains intact. This script never runs extractors.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil

from contract import file_hash, identity_hash, immutable_json, page_content_hash, validate_manifest
from fools_gold_v4_common import record_hash
from v4_reference import page_reference
from approval_v4 import validate_approval


def safe_path(root, value):
    path = Path(value)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('unsafe-artifact-path')
    return root / path


def validate_inventory(manifest, spec):
    if manifest.get('schema') != 'mixed-pdf-manifest@4':
        raise ValueError('unsupported-generation-manifest')
    plan = {f['familyId']: f for f in spec['dataset']['family_plan']}
    stage = manifest.get('stage')
    if stage == 'prototypes':
        expected = {f for f, v in plan.items() if v['classId'] == 'P'}
    elif stage == 'factorial-pilot':
        expected = set(sorted(plan)[:18])
    elif stage == 'full':
        expected = set(plan)
    else:
        raise ValueError('unknown-generation-stage')
    if stage != 'full' and any(plan[f]['split'] != 'train' for f in expected):
        raise ValueError('protected-split-in-development-stage')
    families = defaultdict(list)
    ids = set()
    paths = set()
    owners = {}
    ancestry = {}
    multiple_splits = len({c['split'] for c in manifest.get('cases', [])}) > 1
    for case in manifest.get('cases', []):
        ident = case['id']
        if not re.fullmatch(r'[A-Za-z0-9_-]+', ident) or ident in ids:
            raise ValueError('invalid-case-id')
        ids.add(ident)
        family = case['familyId']
        if any(type(case[k]) is not int for k in ['familyId', 'hardPercent', 'pages']):
            raise ValueError('invalid-case-factor-types')
        if family not in expected or case['split'] != plan[family]['split'] or case['pages'] != 10:
            raise ValueError('unexpected-case-membership')
        if any(case[k] != plan[family][k] for k in ['classId', 'layoutId']):
            raise ValueError('changed-family-contract')
        identity = []
        for key in ['sha256', 'sourceLayoutHash', 'authoringHash', 'worldHash', 'nativePdfHash']:
            value = case.get(key)
            if key == 'nativePdfHash' and value is None:
                continue
            if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
                raise ValueError('missing-source-identity')
            owner = owners.setdefault((key, value), case['split'])
            if owner != case['split']:
                raise ValueError('cross-split-source-identity')
            if key != 'sha256':
                identity.append((key, value))
        hashes = case.get('pageContentHashes')
        if multiple_splits and hashes is None:
            raise ValueError('missing-predeclared-page-identities')
        if hashes is not None:
            if not isinstance(hashes, list) or len(hashes) != 10:
                raise ValueError('invalid-predeclared-page-identities')
            for digest in hashes:
                if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest):
                    raise ValueError('invalid-predeclared-page-identity')
                owner = owners.setdefault(('page', digest), case['split'])
                if owner != case['split']:
                    raise ValueError('cross-split-page-content')
            identity.append(('pages', tuple(hashes)))
        if ancestry.setdefault(family, identity) != identity:
            raise ValueError('inconsistent-family-ancestry')
        for field in ['pdf', 'labels']:
            safe_path(Path('.'), case[field])
            if case[field] in paths:
                raise ValueError('duplicate-artifact-path')
            paths.add(case[field])
        families[family].append(case['hardPercent'])
    if set(families) != expected or any(sorted(v) != [0, 20, 40, 60, 80, 100] for v in families.values()):
        raise ValueError('incomplete-declared-stage')
    counts = dict(families=len(expected), pdfs=len(ids), pages=len(ids) * 10)
    if manifest['counts'] != counts:
        raise ValueError('generation-count-mismatch')
    return counts


def seal(root, out, approval_path):
    if out.exists():
        raise FileExistsError('evaluation output must be new')
    original_path = root / 'manifest.json'
    original = json.loads(original_path.read_text())
    if record_hash(original, 'manifestHash') != original['manifestHash']:
        raise ValueError('generation-manifest-self-hash')
    spec_path = root / 'handoff' / 'spec-a4.json'
    spec = json.loads(spec_path.read_text())
    if file_hash(spec_path) != original['specHash']:
        raise ValueError('changed-frozen-specification')
    validate_inventory(original, spec)
    approval = json.loads(approval_path.read_text())
    validate_approval(approval, original, file_hash(original_path), candidate=root, spec=spec)
    compiled = []
    integrity_cases = []
    out.mkdir(parents=True, exist_ok=False)
    # No case label or authoring record is opened before both guards above pass.
    for case in original['cases']:
        folder = root / 'sources' / f"{case['familyId']:04d}"
        authoring = json.loads((folder / 'authoring.json').read_text())
        if record_hash(authoring, 'authoringHash') != case['authoringHash']:
            raise ValueError('changed-authoring-reference')
        world = json.loads((folder / 'world.json').read_text())
        if record_hash(world, 'worldHash') != case['worldHash'] or authoring['worldHash'] != case['worldHash']:
            raise ValueError('changed-world-reference')
        if file_hash(folder / 'source-layout.json') != case['sourceLayoutHash']:
            raise ValueError('changed-printed-reference')
        pdf = safe_path(root, case['pdf'])
        label_path = safe_path(root, case['labels'])
        if file_hash(pdf) != case['sha256'] or file_hash(label_path) != case['labelHash']:
            raise ValueError('changed-case-artifact')
        labels = json.loads(label_path.read_text())
        if record_hash(labels, 'labelsHash') != labels['labelsHash'] or labels['authoringHash'] != case['authoringHash']:
            raise ValueError('label-authoring-binding')
        if len(labels['pages']) != 10 or len(authoring['pages']) != 10:
            raise ValueError('page-count-mismatch')
        refs = []
        for source, page in zip(authoring['pages'], labels['pages']):
            if source['id'] != page['pageId']:
                raise ValueError('changed-page-order')
            for key in ['blocks', 'readingOrder', 'expectedMarkdown', 'sections', 'paragraphs']:
                if source[key] != page[key]:
                    raise ValueError('changed-delivered-gold')
            refs.append(page_reference(page))
        family = f"mixed-source-{case['familyId']:04d}"
        result = dict(schema='mixed-pdf-authored@v2', family=family, split=case['split'], pages=refs,
                      labels=[dict(name='visible_page_content', expected=[p['expectedMarkdown'] for p in refs])])
        bare = [{k: v for k, v in p.items() if k != 'pageId'} for p in refs]
        content_hashes = [page_content_hash(p) for p in bare]
        if case.get('pageContentHashes') is not None and case['pageContentHashes'] != content_hashes:
            raise ValueError('predeclared-page-content-mismatch')
        row = dict(id=case['id'], family=family, split=case['split'], pdf=case['pdf'],
                   labels=f"labels/{case['split']}/{case['id']}.json", sha256=case['sha256'],
                   sourceLayoutHash=case['sourceLayoutHash'], sourceContentHash=identity_hash([p['expectedMarkdown'] for p in refs]),
                   pageIds=[p['pageId'] for p in refs], pageReferenceHashes=[identity_hash(p) for p in bare],
                   pageContentHashes=content_hashes, hardPercent=case['hardPercent'],
                   pages=[dict(pageId=p['pageId']) for p in refs], authoringHash=case['authoringHash'],
                   worldHash=case['worldHash'], layout=case['layoutId'], classId=case['classId'],
                   baseRegionRasterShare=case['sectionRasterShare'], producerPath=case['producerPath'])
        target = out / row['pdf']; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pdf, target)
        if file_hash(target) != row['sha256']:
            raise ValueError('copied-pdf-hash-mismatch')
        immutable_json(out / row['labels'], result)
        row['labelHash'] = file_hash(out / row['labels'])
        compiled.append(row)
        integrity_cases.append(dict(id=row['id'], source=dict(path=row['pdf'], sha256=row['sha256']),
            labels=dict(path=row['labels'], sha256=row['labelHash']),
            provenance=dict(kind='authored', author='DocSlurp clean-room corpus Builder',
                createdAt=datetime.fromtimestamp((folder / 'authoring.json').stat().st_mtime, timezone.utc).isoformat(),
                description='Immutable original authoring retained before rendering and transformations. Timestamp is the source authoring record filesystem write time; document metadata dates are invented.')))
    counts = original['counts']
    manifest = dict(schema='mixed-pdf-authored@v2', families=counts['families'], pageCount=counts['pages'],
                    cases=compiled, generationManifestHash=file_hash(original_path), generationRoot=str(root),
                    acceptanceReceiptHash=file_hash(approval_path), projectionCodeHash=file_hash(Path(__file__)),
                    referenceAdapterHash=file_hash(Path(__file__).with_name('v4_reference.py')))
    manifest['approvalCodeHash'] = file_hash(Path(__file__).with_name('approval_v4.py'))
    manifest['projectionDependencyHashes'] = {name: file_hash(Path(__file__).with_name(name))
        for name in ['approval_v4.py', 'contract.py', 'fools_gold_v4_common.py', 'v4_reference.py']}
    validate_manifest(manifest)
    immutable_json(out / 'manifest.json', manifest)
    immutable_json(out / 'generation-manifest.json', original)
    immutable_json(out / 'acceptance-receipt.json', approval)
    immutable_json(out / 'integrity-manifest.json', dict(schema='docslurp-authored-eval@v1', cases=integrity_cases))
    print(json.dumps(dict(projectedCases=len(compiled), pages=counts['pages'])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--approval', type=Path, required=True)
    args = parser.parse_args()
    seal(args.dataset.resolve(), args.out.resolve(), args.approval.resolve())
