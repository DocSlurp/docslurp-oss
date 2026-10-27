"""Bind generated labels to pre-render authoring references without changing PDF bytes.

This automated provenance pass emits counts only, including for heldout families.
Original generation manifests and labels remain intact; measurements use sealed labels.
"""
import argparse,json
from pathlib import Path
from contract import file_hash,identity_hash,immutable_json,validate_manifest,page_content_hash

def seal(root):
    original=root/'generation-manifest.json'
    if not original.exists():immutable_json(original,json.loads((root/'manifest.json').read_text()))
    manifest=json.loads(original.read_text())
    integrity=json.loads((root/'integrity-manifest.json').read_text())
    by_id={c['id']:c for c in integrity['cases']}
    for case in manifest['cases']:
        source=root/'sources'/f"{case['family']}.json"
        if file_hash(source)!=case['sourceLayoutHash']:raise RuntimeError('changed-authoring-reference')
        authored=json.loads(source.read_text())
        labels=json.loads((root/case['labels']).read_text())
        if file_hash(root/case['labels'])!=case['labelHash'] or labels['pages']!=authored['pages']:raise RuntimeError('label-authoring-order-mismatch')
        if file_hash(root/case['pdf'])!=case['sha256']:raise RuntimeError('changed-pdf')
        refs=authored['pages']
        case['pageContentHashes']=[page_content_hash(p) for p in refs]
        case['pageReferenceHashes']=[identity_hash(p) for p in refs]
        case['sourceContentHash']=identity_hash([p['expectedMarkdown'] for p in refs])
        case['pageIds']=[f"{case['sourceLayoutHash']}:{i+1}" for i in range(len(refs))]
        labels['pages']=[{**p,'pageId':pid} for p,pid in zip(refs,case['pageIds'])]
        path=root/'sealed-labels'/case['split']/f"{case['id']}.json"
        immutable_json(path,labels)
        case['labels']=str(path.relative_to(root));case['labelHash']=file_hash(path)
        by_id[case['id']]['labels']={'path':case['labels'],'sha256':case['labelHash']}
    manifest['generationManifestHash']=file_hash(original)
    manifest['sealCodeHash']=file_hash(Path(__file__))
    validate_manifest(manifest)
    immutable_json(root/'sealed-manifest.json',manifest)
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2))
    (root/'integrity-manifest.json').write_text(json.dumps(integrity,indent=2))
    print(json.dumps({'sealedCases':len(manifest['cases']),'pages':manifest['pageCount']}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--dataset',type=Path,required=True)
    seal(p.parse_args().dataset)
