#!/usr/bin/env python3
"""Declare a pinned product taxonomy for typed integrity fields, preserving gold.

Run after corpus.py. This changes integrity metadata only. Original label files
and manifest bytes remain available; images, reference geometry, source layouts,
selection and benchmark manifests are never written by this script.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def declare(dataset, repo, commit):
    dataset, repo = Path(dataset).resolve(), Path(repo).resolve()
    manifest_path = dataset / 'integrity-manifest.json'
    original = manifest_path.read_bytes()
    manifest = json.loads(original)
    if manifest.get('integrityMetadataRevision') == 'typed-categorical-v1.1':
        raise ValueError('Typed metadata is already declared; preserve the existing freeze.')
    if manifest.get('schema') != 'docslurp-authored-eval@v1':
        raise ValueError('Only the authored layout corpus manifest is supported.')
    contract_path, export_name = 'worker/src/layout/image-layout.ts', 'imageLayoutLabels'
    full_commit = git(repo, 'rev-parse', '--verify', f'{commit}^{{commit}}').decode().strip()
    git(repo, 'merge-base', '--is-ancestor', full_commit, 'HEAD')
    contract = git(repo, 'show', f'{full_commit}:{contract_path}')
    match = re.search(r'export const imageLayoutLabels\s*=\s*(\[[^\]]*\])\s*as const', contract.decode())
    if not match:
        raise ValueError('Missing exact product taxonomy export.')
    values = json.loads(match.group(1))
    if not values or not all(isinstance(value, str) for value in values) or len(set(values)) != len(values):
        raise ValueError('Invalid product taxonomy.')
    ontology = {'schema': 'docslurp-categorical-ontology@v1', 'values': values,
                'contract': {'path': contract_path, 'gitCommit': full_commit,
                             'sha256': sha(contract), 'exportName': export_name},
                'provenance': {'author': 'DocSlurp layout corpus integrity declaration',
                               'description': 'Complete generic product output taxonomy, pinned independently of evaluation values; only region label fields are categorical.',
                               'createdAt': '2026-10-20T00:00:00Z'}}
    ontology_bytes = json_bytes(ontology)
    declaration = [{'pointer': '/*/label', 'ontology': {'path': 'ontology.json', 'sha256': sha(ontology_bytes)}}]
    protected = ['manifest.jsonl', 'manifest.json', 'benchmark-slice.jsonl', 'selection-policy.json']
    protected_hashes = {name: sha((dataset / name).read_bytes()) for name in protected}
    before_expected, after_expected = hashlib.sha256(), hashlib.sha256()
    outputs = []
    for case in manifest['cases']:
        label_path = (dataset / case['labels']['path']).resolve()
        if not label_path.is_relative_to(dataset):
            raise ValueError('Label path outside dataset.')
        label_bytes = label_path.read_bytes()
        if sha(label_bytes) != case['labels']['sha256']:
            raise ValueError('Original label artifact hash mismatch.')
        payload = json.loads(label_bytes)
        if len(payload.get('labels', [])) != 1 or payload['labels'][0].get('name') != 'layout_regions':
            raise ValueError('Unexpected label structure; refusing broad categorical exemption.')
        label = payload['labels'][0]
        if label.get('categoricalFields'):
            raise ValueError('Existing categorical declaration requires independent review.')
        expected = label['expected']
        if not isinstance(expected, list) or not expected or any(region.get('label') not in values for region in expected):
            raise ValueError('Region labels must belong to the complete pinned product taxonomy.')
        before_expected.update(json_bytes({'id': case['id'], 'expected': expected}))
        label['categoricalFields'] = declaration
        after_expected.update(json_bytes({'id': case['id'], 'expected': label['expected']}))
        relative = Path('integrity-labels-v1.1') / label_path.name
        encoded = json_bytes(payload)
        outputs.append((dataset / relative, encoded))
        case['labels'] = {'path': str(relative), 'sha256': sha(encoded)}
    if before_expected.digest() != after_expected.digest():
        raise AssertionError('Expected geometry/labels changed.')
    backup = dataset / 'integrity-manifest-untyped.json'
    if backup.exists() and backup.read_bytes() != original:
        raise ValueError('Existing original manifest backup differs.')
    backup.write_bytes(original)
    (dataset / 'ontology.json').write_bytes(ontology_bytes)
    for path, encoded in outputs:
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(encoded)
    manifest['integrityMetadataRevision'] = 'typed-categorical-v1.1'
    manifest['previousIntegrityManifestSha256'] = sha(original)
    final = json_bytes(manifest)
    manifest_path.write_bytes(final)
    for name, digest in protected_hashes.items():
        if sha((dataset / name).read_bytes()) != digest:
            raise AssertionError('A protected image/reference/selection manifest changed.')
    receipt = {'schema': 'layout-integrity-metadata-migration@v1', 'cases': len(outputs),
               'previous_integrity_manifest_sha256': sha(original), 'integrity_manifest_sha256': sha(final),
               'ontology_sha256': sha(ontology_bytes), 'contract': ontology['contract'],
               'expected_geometry_and_labels_sha256_before': before_expected.hexdigest(),
               'expected_geometry_and_labels_sha256_after': after_expected.hexdigest(),
               'protected_manifests_unchanged': protected_hashes,
               'original_labels_retained': 'integrity-labels/',
               'original_manifest_retained': backup.name,
               'note': 'Typed categorical metadata only; no image, source layout, reference geometry or selection change.'}
    (dataset / 'integrity-ontology-migration.json').write_bytes(json_bytes(receipt))
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--contract-commit', required=True)
    args = parser.parse_args()
    print(json.dumps(declare(args.dataset, args.repo, args.contract_commit), indent=2))
