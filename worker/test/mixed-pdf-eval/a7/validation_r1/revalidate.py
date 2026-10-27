"""Seal implementation first, then read-only inspect the six existing R4 PDFs."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import sys
import validator as v

ROOT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7')
OUT=ROOT/'validation-r1'
ROUND=ROOT/'round4'

def write(name,obj):
    p=OUT/name
    if p.exists():raise RuntimeError('Refusing to overwrite receipt: '+str(p))
    p.write_text(json.dumps(obj,indent=2,allow_nan=False)+'\n')

def main():
    before=json.loads((OUT/'preservation-before.json').read_text())
    freeze=json.loads((ROUND/'FREEZE.json').read_text())
    require_files={str(ROUND/k):expected for k,expected in freeze['files'].items()}
    if len(require_files)!=59:raise RuntimeError('Expected exactly 59 FREEZE entries')
    native=sorted([*ROUND.glob('*-original.pdf'),*ROUND.glob('*-original.odt')])
    if len(native)!=9:raise RuntimeError('Expected exactly 9 native artifacts')
    # Compare installed dependencies against the prior R4 pinned runtime receipt.
    prior=json.loads((ROUND/'runtime-source-receipt.json').read_text())
    lock=json.loads((v.HERE/'runtime-lock.json').read_text())
    normalized={k.lower():d for k,d in prior['packages'].items()}
    for name,dist in lock['packages'].items():
        old=normalized[name.lower()]
        if old['version']!=dist['version']:raise RuntimeError('Prior runtime version mismatch: '+name)
        for rel,h in old['files'].items():
            if v.sha((Path(dist['root'])/rel).read_bytes())!=h:raise RuntimeError('Prior runtime hash mismatch: '+name+'/'+rel)
    if lock['font']['sha256']!=prior['fonts']['mono']['sha256']:raise RuntimeError('Prior font mismatch')
    runtime_hash=v.runtime()
    source={str(p):v.sha(p.read_bytes()) for p in sorted(v.HERE.iterdir()) if p.is_file()}
    implementation_hash=v.sha(json.dumps(source,sort_keys=True).encode())
    seal={'validatorVersion':v.VERSION,'sealedAtUtc':datetime.now(timezone.utc).isoformat(),'files':source,'implementationSha256':implementation_hash,'runtimeLockSha256':runtime_hash,'priorRuntimeReceiptSha256':v.sha((ROUND/'runtime-source-receipt.json').read_bytes()),'frozenHelperSha256':v.HELPER_SHA}
    write('VALIDATOR-FREEZE.json',seal)
    reports=[]
    for p in sorted(ROUND.glob('*-original.pdf')):
        reports.append(v.inspect(p))
    if len(reports)!=6:raise RuntimeError('Expected six PDFs')
    # Independently retain rotated-label trace evidence; no rendering or rewriting.
    import pymupdf
    rotations=[]
    for p in sorted(ROUND.glob('*-original.pdf')):
        with pymupdf.open(p) as doc:
            spans=[{'direction':s['dir'],'sizePt':s['size'],'glyphCount':len(s['chars']),'origins':[list(c[2]) for c in s['chars']]} for s in doc[0].get_texttrace() if abs(s['dir'][1])>.5]
            if spans:rotations.append({'pdf':str(p),'sha256':v.sha(p.read_bytes()),'rotatedSpans':spans})
    write('revalidation.json',{'observedAtUtc':datetime.now(timezone.utc).isoformat(),'sealSha256':v.sha((OUT/'VALIDATOR-FREEZE.json').read_bytes()),'implementationSha256':implementation_hash,'reports':reports,'rotatedNativeEvidence':rotations,'scope':'Only guarded embedded-outline-versus-active-rectangular-clips; no candidate/fixture/extraction/score acceptance. Unsupported mechanisms refuse coverage. No occlusion analysis.'})
    after={p:{'sha256':v.sha(Path(p).read_bytes()),'beforeSha256':r['sha256'],'unchanged':v.sha(Path(p).read_bytes())==r['sha256'],'freezeMatch':p not in require_files or v.sha(Path(p).read_bytes())==require_files[p]} for p,r in before['files'].items()}
    immutable=all(v.sha(Path(p).read_bytes())==h for p,h in source.items())
    write('preservation-after.json',{'observedAtUtc':datetime.now(timezone.utc).isoformat(),'freezeEntryCount':59,'nativeArtifactCount':9,'files':after,'allUnchanged':all(r['unchanged'] and r['freezeMatch'] for r in after.values()),'sealedImplementationUnchanged':immutable})
    print(json.dumps({'pdfs':len(reports),'complete':sum(r['completeForObservedMechanisms'] for r in reports),'noOutlineClipMisses':sum(r['noOutlineClipMisses'] for r in reports),'preserved':all(r['unchanged'] for r in after.values()),'implementationUnchanged':immutable,'implementationSha256':implementation_hash,'rotatedPDFs':len(rotations)}))
    return 0 if immutable and all(r['unchanged'] for r in after.values()) and all(r['completeForObservedMechanisms'] for r in reports) else 1

if __name__=='__main__':sys.exit(main())
