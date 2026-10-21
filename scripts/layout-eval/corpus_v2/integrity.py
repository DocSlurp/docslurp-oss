#!/usr/bin/env python3
"""Prepare typed geometry-only integrity labels from an immutable V2 candidate lock."""
import argparse, hashlib, json, re, subprocess
from pathlib import Path


def digest(data):return hashlib.sha256(data).hexdigest()
def encode(value):return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()
def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--repo',type=Path,required=True);p.add_argument('--contract-commit',default='37585134');a=p.parse_args()
    root=a.root.resolve();repo=a.repo.resolve();lock=root/'frozen-v2/LOCK.json'
    if not lock.exists():raise ValueError('Split must be locked before integrity artifacts are prepared')
    frozen=json.loads(lock.read_text());manifest=root/'frozen-v2/candidates.jsonl'
    if digest(manifest.read_bytes())!=frozen['outputs']['candidates.jsonl']:raise ValueError('Candidate manifest differs from lock')
    def git(*args):return subprocess.check_output(['git','-C',str(repo),*args])
    commit=git('rev-parse',a.contract_commit+'^{commit}').decode().strip();contract_path='worker/src/layout/image-layout.ts'
    git('merge-base','--is-ancestor',commit,'HEAD');contract=git('show',commit+':'+contract_path)
    match=re.search(r'export const imageLayoutLabels\s*=\s*(\[[^\]]*\])\s*as const',contract.decode())
    if not match:raise ValueError('Pinned product ontology export missing')
    values=json.loads(match[1]);ontology={'schema':'docslurp-categorical-ontology@v1','values':values,
        'contract':{'path':contract_path,'gitCommit':commit,'sha256':digest(contract),'exportName':'imageLayoutLabels'},
        'provenance':{'author':'DocSlurp V2 layout integrity preparation','description':'Complete pre-existing generic output taxonomy, scoped only to expected region label fields.','createdAt':'2026-10-21T02:00:00Z'}}
    ontology_bytes=encode(ontology);(root/'integrity-ontology-v2.json').write_bytes(ontology_bytes)
    destination=root/'integrity-labels-v2';destination.mkdir(exist_ok=True);cases=[]
    for row in map(json.loads,manifest.read_text().splitlines()):
        regions=[{k:r[k] for k in ['label','bbox','polygon'] if k in r} for r in row['regions']]
        if any(r['label'] not in values for r in regions):raise ValueError('Unknown product category')
        payload={'labels':[{'name':'layout_regions','expected':regions,'categoricalFields':[{'pointer':'/*/label','ontology':{'path':'integrity-ontology-v2.json','sha256':digest(ontology_bytes)}}]}]}
        label_path=destination/(row['id']+'.json');data=encode(payload);label_path.write_bytes(data)
        image=Path(row['image_path']).resolve()
        if not image.is_relative_to(root):raise ValueError('Image outside durable corpus root')
        cases.append({'id':'v2-layout-'+row['id'],'source':{'path':str(image.relative_to(root)),'sha256':digest(image.read_bytes())},
                      'labels':{'path':str(label_path.relative_to(root)),'sha256':digest(data)},
                      'provenance':{'kind':'authored','author':'DocSlurp task agents; authored layout annotations',
                                    'description':'Annotation geometry is authored source-first for native pages, mapped for synthetic derivatives, or explicitly manual silver for the preserved public-domain historical raster. This declaration does not call historical image pixels authored or independently validated.',
                                    'createdAt':'2026-10-21T02:00:00Z'}})
    (root/'integrity-manifest.json').write_bytes(encode({'schema':'docslurp-authored-eval@v1','integrityMetadataRevision':'v2-typed-layout-geometry','candidateLockSha256':digest(lock.read_bytes()),'generatorSha256':digest(Path(__file__).read_bytes()),'cases':cases}))
    print(json.dumps({'cases':len(cases),'manifestSha256':digest((root/'integrity-manifest.json').read_bytes())}))
if __name__=='__main__':main()
