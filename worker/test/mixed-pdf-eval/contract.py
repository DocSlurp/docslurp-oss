"""Fail-closed evaluation inventory/provenance checks, before opening candidate data."""
import hashlib,json,re,subprocess,sys
import importlib.metadata
import shutil
import unicodedata
from collections import Counter,defaultdict
from pathlib import Path

def digest(value): return hashlib.sha256(value).hexdigest()
def file_hash(path): return digest(Path(path).read_bytes())
def identity_hash(value): return digest(json.dumps(value,sort_keys=True,separators=(',',':')).encode())
def page_content_hash(page):
    return identity_hash(re.findall(r'\w+',unicodedata.normalize('NFKC',page['expectedMarkdown']).casefold()))

def immutable_json(path,value):
    path=Path(path)
    if path.exists():
        if json.loads(path.read_text())!=value: raise RuntimeError(f"immutable-contract-mismatch:{path.name}")
    else:
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('x') as stream:json.dump(value,stream,indent=2)

def validate_manifest(manifest):
    cases=manifest.get('cases',[])
    if not cases or manifest.get('schema')!='mixed-pdf-authored@v2':raise RuntimeError('unsupported-corpus')
    seen=set();families=defaultdict(list);owners={}
    for case in cases:
        if not re.fullmatch(r'[a-zA-Z0-9_-]+',case.get('id','')) or case['id'] in seen:raise RuntimeError('invalid-case-id')
        seen.add(case['id']);families[case['family']].append(case)
        if case['split'] not in ['train','tune','heldout'] or len(case['pages'])!=10:raise RuntimeError('invalid-case-shape')
        for field in ['sha256','labelHash','sourceLayoutHash','sourceContentHash']:
            if not re.fullmatch('[0-9a-f]{64}',case.get(field,'')):raise RuntimeError('missing-content-hash')
        for key in ['sha256','sourceLayoutHash','sourceContentHash']:
            owner=owners.setdefault((key,case[key]),case['split'])
            if owner!=case['split']:raise RuntimeError('cross-split-source-identity')
        if len(case.get('pageIds',[]))!=10 or len(set(case['pageIds']))!=10 or len(case.get('pageReferenceHashes',[]))!=10:raise RuntimeError('missing-page-identity')
        if len(case.get('pageContentHashes',[]))!=10:raise RuntimeError('missing-page-content-identity')
        for value in case['pageContentHashes']:
            if not re.fullmatch('[0-9a-f]{64}',value):raise RuntimeError('invalid-page-content-hash')
            owner=owners.setdefault(('pageContent',value),case['split'])
            if owner!=case['split']:raise RuntimeError('cross-split-page-content')
        for field in ['pdf','labels']:
            path=Path(case[field])
            if path.is_absolute() or '..' in path.parts:raise RuntimeError('unsafe-artifact-path')
    for rows in families.values():
        if len({r['split'] for r in rows})!=1:raise RuntimeError('cross-split-family')
        if len({r['sourceContentHash'] for r in rows})!=1 or len({r['sourceLayoutHash'] for r in rows})!=1:raise RuntimeError('inconsistent-derivative-ancestry')
        if sorted(r['hardPercent'] for r in rows)!=[0,20,40,60,80,100]:raise RuntimeError('incomplete-family')
    if len(families)!=manifest['families'] or len(cases)*10!=manifest['pageCount']:raise RuntimeError('incomplete-corpus')
    return cases

def evaluation_identity(root,scorers,measure_path,ocr_binary_hash,ocr_language_hash,render_version):
    versions={}
    for command in ['pdftotext','pdfimages','qpdf','tesseract']:
        r=subprocess.run([command,'--version'] if command in ['qpdf','tesseract'] else [command,'-v'],capture_output=True,timeout=10)
        versions[command]=(r.stdout+r.stderr).decode().splitlines()[0]
    return {'datasetHash':file_hash(root/'manifest.json'),'datasetCanonicalHash':identity_hash(json.loads((root/'manifest.json').read_text())),'measureHash':file_hash(measure_path),
            'contractHash':file_hash(Path(__file__)),
            'spatialCaptureHash':file_hash(Path(measure_path).with_name('spatial_evidence.py')),
            'scorerHashes':{p.name:file_hash(p) for p in sorted(Path(scorers).glob('*.py'))},
            'ocrBinaryHash':ocr_binary_hash,'ocrLanguageHash':ocr_language_hash,'pymupdf':render_version,
            'python':sys.version,'toolVersions':versions,'toolHashes':{tool:file_hash(shutil.which(tool)) for tool in versions},
            'dependencies':{name:importlib.metadata.version(name) for name in ['Pillow','latex2mathml','markdown-it-py','lxml']},'ocrSettings':[[150,6],[300,3]]}

def validate_policy_receipt(receipt,identity,optimizer_hash,tuning_inventory_hash):
    if receipt.get('schema')!='mixed-pdf-policy@v2':raise RuntimeError('invalid-policy-receipt')
    if receipt.get('evaluationIdentity')!=identity:raise RuntimeError('policy-evaluation-identity-mismatch')
    if receipt.get('optimizerHash')!=optimizer_hash:raise RuntimeError('policy-optimizer-mismatch')
    if receipt.get('tuningInventoryHash')!=tuning_inventory_hash:raise RuntimeError('policy-tuning-inventory-mismatch')
    policy=receipt.get('policy',{})
    if policy.get('mode') not in ['native','ocr-fast','ocr-strong','ladder']:raise RuntimeError('invalid-policy-mode')
    if policy['mode']=='ladder':
        for key in ['glyphThreshold','imageThreshold','confidenceThreshold','byteThreshold','vectorThreshold']:
            value=policy.get(key)
            if not isinstance(value,(int,float)) or not 0<=value<=1_000_000:raise RuntimeError('invalid-policy-threshold')
        if policy.get('byteBasis') not in ['contentDecodedBytes','singleResidualBytes','fourResidualBytes']:raise RuntimeError('invalid-byte-basis')

def validate_labels(labels,case,pages):
    if labels.get('family')!=case['family'] or labels.get('split')!=case['split'] or len(labels.get('pages',[]))!=pages:
        raise RuntimeError('label-page-or-family-mismatch')
    if [p.get('pageId') for p in labels['pages']]!=case['pageIds']:raise RuntimeError('label-page-order-mismatch')
    if [identity_hash({k:v for k,v in p.items() if k!='pageId'}) for p in labels['pages']]!=case['pageReferenceHashes']:raise RuntimeError('label-source-reference-mismatch')
    if [page_content_hash(p) for p in labels['pages']]!=case['pageContentHashes']:raise RuntimeError('label-content-identity-mismatch')

def validate_complete_inventory(inventory,split):
    if inventory.get('schema')!='mixed-pdf-complete@v2' or inventory.get('split')!=split:raise RuntimeError('invalid-completed-inventory')
    cases=inventory.get('cases',[])
    if not cases or len({c['id'] for c in cases})!=len(cases):raise RuntimeError('missing-or-duplicate-results')
    if set(inventory.get('resultHashes',{}))!={c['id'] for c in cases}:raise RuntimeError('result-hash-membership-mismatch')
    families=defaultdict(list)
    for c in cases:
        if c['split']!=split or not re.fullmatch(r'[a-zA-Z0-9_-]+',c['id']):raise RuntimeError('inventory-split-mismatch')
        families[c['family']].append(c['hardPercent'])
    if any(sorted(v)!=[0,20,40,60,80,100] for v in families.values()):raise RuntimeError('incomplete-result-family')

def validate_panel_binding(inventory,panel,panel_hash):
    if panel.get('schema')!='mixed-pdf-panel@v2' or inventory.get('panelHash')!=panel_hash:raise RuntimeError('panel-hash-mismatch')
    for key in ['split','evaluationIdentityHash','policyHash','selectedFamilies','cases']:
        if inventory.get(key)!=panel.get(key):raise RuntimeError('completed-panel-membership-mismatch')

def validate_panel_manifest(panel,manifest):
    cases=validate_manifest(manifest)
    families=panel.get('selectedFamilies',[])
    expected=[c for c in cases if c['split']==panel['split'] and c['family'] in families]
    keys=['id','family','split','hardPercent','sha256','labelHash']
    if not families or {c['family'] for c in expected}!=set(families):raise RuntimeError('invalid-panel-selection')
    if panel['cases']!=[{k:c[k] for k in keys} for c in expected]:raise RuntimeError('panel-manifest-membership-mismatch')
