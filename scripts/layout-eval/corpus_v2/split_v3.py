#!/usr/bin/env python3
"""Assign V3 source groups to development / validation / test before any evaluation.

Metadata only: reads manifests and source JSON, never images' predictions or model
output. A group is the transitive closure of (a) the declared source cluster,
(b) any shared real or generated inserted asset (same SHA-256), and (c) capture or
quality-derivative parentage. Whole groups go to one split. Assignment is a seeded
greedy fill toward target page shares, so it is reproducible and inspectable.

Writes splits/{development,validation,test}.jsonl, splits/SPLIT-RECEIPT.json and a
frozen-v3/ candidate lock compatible with integrity.py.
"""
import argparse
import collections
import datetime
import hashlib
import json
from pathlib import Path

SPLITS = ('development', 'validation', 'test')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Groups:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def load(root):
    root = Path(root)
    native = [json.loads(line) for line in (root / 'pilot-manifest.jsonl').read_text().splitlines() if line.strip()]
    variants = [json.loads(p.read_text()) for p in sorted((root / 'captures').glob('*.row.json'))] if (root / 'captures').exists() else []
    real = []
    real_manifest = root / 'real-pages' / 'manifest.jsonl'
    if real_manifest.exists():
        real = [json.loads(line) for line in real_manifest.read_text().splitlines() if line.strip()]
    return native, variants, real


def inserted_assets(root, row):
    source = json.loads((Path(root) / row['metadata']['source_path']).read_text())
    hashes = set()
    for command in source['commands']:
        if command['op'] == 'image':
            hashes.add(sha(command['path']))
    for region in source['regions']:
        asset = region['attributes'].get('asset') or {}
        if asset.get('original_sha256'):
            hashes.add(asset['original_sha256'])
    # exclude typeset formula rasters: they are deterministic renders of an expression, not shared content
    return {h for h in hashes}, source


def assign(root, seed=20261021, targets=(0.5, 0.25, 0.25)):
    root = Path(root)
    native, variants, real = load(root)
    groups = Groups()
    page_cluster = {}
    features = {}
    asset_owner = {}
    for row in native:
        cluster = row['metadata']['source_cluster']
        page_cluster[row['id']] = cluster
        groups.union('page:' + row['id'], 'cluster:' + cluster)
        hashes, source = inserted_assets(root, row)
        math_assets = {sha(c['path']) for c in source['commands'] if c['op'] == 'image' and '/assets/math/' in c['path']}
        for h in hashes - math_assets:
            groups.union('page:' + row['id'], 'asset:' + h)
            asset_owner.setdefault(h, set()).add(row['id'])
        features[row['id']] = row['metadata'].get('declared_features', [])
    for row in real:
        groups.union('page:' + row['id'], 'cluster:' + row['metadata']['source_cluster'])
        groups.union('page:' + row['id'], 'asset:' + row['metadata']['original_sha256'])
        features[row['id']] = row['metadata'].get('declared_features', [])
    for row in variants:
        parent = row['metadata']['source_id']
        if parent not in page_cluster:
            raise ValueError(f'Variant {row["id"]} has unknown parent {parent}')
        groups.union('page:' + row['id'], 'page:' + parent)
    members = collections.defaultdict(list)
    for row in native + real + variants:
        members[groups.find('page:' + row['id'])].append(row['id'])
    base_count = {g: sum(1 for i in ids if i in features) for g, ids in members.items()}
    order = sorted(members, key=lambda g: hashlib.sha256(f'{seed}|{sorted(members[g])}'.encode()).hexdigest())
    totals = dict.fromkeys(SPLITS, 0)
    total_base = sum(base_count.values())
    group_split = {}
    for g in order:
        deficit = {s: targets[i] * total_base - totals[s] for i, s in enumerate(SPLITS)}
        choice = max(SPLITS, key=lambda s: (deficit[s], -SPLITS.index(s)))
        group_split[g] = choice
        totals[choice] += base_count[g]
    split_of = {i: group_split[g] for g, ids in members.items() for i in ids}
    return native, real, variants, members, group_split, split_of, features, asset_owner


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--seed', type=int, default=20261021)
    a = p.parse_args()
    root = a.root.resolve()
    native, real, variants, members, group_split, split_of, features, asset_owner = assign(root, a.seed)
    out = root / 'splits'
    out.mkdir(exist_ok=True)
    rows_by_split = collections.defaultdict(list)
    candidates = []
    for row in native + real + variants:
        record = dict(row)
        image = Path(row['image_path'])
        record['image_path'] = str(image if image.is_absolute() else root / image)
        record['split'] = split_of[row['id']]
        record['candidate_kind'] = 'variant' if row in variants else 'real-page' if row in real else 'native-base'
        rows_by_split[record['split']].append(record)
        candidates.append(record)
    for s in SPLITS:
        (out / f'{s}.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows_by_split[s]))
    coverage = {s: collections.Counter(f for r in rows_by_split[s] if r['candidate_kind'] != 'variant' for f in features.get(r['id'], [])) for s in SPLITS}
    receipt = {'schema': 'layout-source-group-split-v3', 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'seed': a.seed, 'targets_base_pages': dict(zip(SPLITS, (0.5, 0.25, 0.25))),
               'algorithm': 'union-find over cluster, shared inserted asset sha256 (excluding typeset formula rasters) and variant parentage; seeded order; greedy fill to base-page targets',
               'inputs': {name: sha(root / name) for name in ['pilot-manifest.jsonl', 'real-pages/manifest.jsonl'] if (root / name).exists()},
               'variant_rows': {r['id']: sha(root / 'captures' / f'{r["id"]}.row.json') for r in variants},
               'groups': [{'group': g, 'split': group_split[g], 'members': sorted(ids)} for g, ids in sorted(members.items())],
               'shared_assets': {h: sorted(ids) for h, ids in asset_owner.items() if len(ids) > 1},
               'counts': {s: {'base_pages': sum(1 for r in rows_by_split[s] if r['candidate_kind'] != 'variant'),
                              'variants': sum(1 for r in rows_by_split[s] if r['candidate_kind'] == 'variant'),
                              'groups': sum(1 for g in group_split.values() if g == s)} for s in SPLITS},
               'declared_feature_coverage_base_pages': {s: dict(sorted(c.items())) for s, c in coverage.items()},
               'policy': 'Assigned before any model run. No detector has been run on any split by this tool. Test rows must not be opened for tuning or run before an explicit, separately approved confirmation protocol.'}
    (out / 'SPLIT-RECEIPT.json').write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + '\n')
    frozen = root / 'frozen-v3'
    frozen.mkdir(exist_ok=True)
    (frozen / 'candidates.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in candidates))
    lock = {'schema': 'layout-v3-candidate-lock', 'createdAt': receipt['createdAt'],
            'outputs': {'candidates.jsonl': sha(frozen / 'candidates.jsonl'), **{f'{s}.jsonl': sha(out / f'{s}.jsonl') for s in SPLITS}},
            'splitReceiptSha256': sha(out / 'SPLIT-RECEIPT.json'),
            'software': {p.name: sha(p) for p in sorted(Path(__file__).parent.glob('*.py'))}}
    (frozen / 'LOCK.json').write_text(json.dumps(lock, indent=2) + '\n')
    print(json.dumps(receipt['counts'], indent=1))


if __name__ == '__main__':
    main()
