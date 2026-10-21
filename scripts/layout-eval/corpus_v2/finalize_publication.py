#!/usr/bin/env python3
"""Audit the frozen candidate metadata, including transitive capture recipes; no evals."""
import argparse,json
from pathlib import Path
from datetime import datetime,timezone
from publish_audit import audit,receipt,sha

def finalize(root):
 publication=root/'publication';clearances=json.loads((publication/'DEPENDENCY-CLEARANCES.json').read_text())
 native=audit(root,clearances)
 (publication/'PUBLISH-MANIFEST.json').write_text(json.dumps(native,indent=2)+'\n')
 notices=['# Dataset attribution (staged candidate, not public release)','','Original dataset contributions: DocSlurp contributors, CC BY 4.0, only to the extent rights are held. https://creativecommons.org/licenses/by/4.0/','Generator code retains repository licensing; no font binaries are exported. Public-domain and CC0 inserts retain individual status. AI-generated assets are not documentary photography.','']
 for dep in clearances['dependencies']:notices.append('- SHA-256 `'+dep['sha256']+'`; '+dep['license']+'; '+dep['attribution']+'. Changes: '+dep['modifications'])
 notices.append('- National Archives, Bill of Rights original image and official transcript; public domain per saved founding-document downloads statement. Manual annotations: DocSlurp contributors, CC BY 4.0 contribution candidate. Coarse silver; no transcription evaluation admission.')
 (publication/'ATTRIBUTION.md').write_text('\n'.join(notices)+'\n')
 native_by={p['id']:p for p in native['publish_entries']+native['excluded_entries']}
 deps={d['sha256']:d for d in clearances['dependencies']};frozen=root/'frozen-v2/candidates.jsonl'
 rows=[json.loads(line) for line in frozen.read_text().splitlines() if line.strip()];out=[]
 for row in rows:
  identifier=row['id'];meta=row.get('metadata',{});issues=[];evidence=[]
  image=Path(row['image_path']);image=image if image.is_absolute() else root/image
  evidence.append({'path':str(image),'sha256':sha(image)})
  if meta.get('image_sha256') and sha(image)!=meta['image_sha256']:issues.append('frozen_image_hash_mismatch')
  if identifier in native_by:
   source=native_by[identifier];issues+=source['rights_issues'];evidence+=list(source['artifacts'].values());label_status=source['label_evidence_status']
  elif (root/'captures'/f'{identifier}.row.json').is_file():
   path=root/'captures'/f'{identifier}.row.json';capture=json.loads(path.read_text());m=capture['metadata'];evidence.append({'path':str(path),'sha256':sha(path)})
   if m['source_id'] not in native_by or native_by[m['source_id']]['rights_status']!='evidence-ready':issues.append('uncleared_parent_source')
   for key in ['source_image','source_reference','source_layout','parent_image','parent_reference']:
    if m.get(key):
     dep=Path(m[key]);expected=m.get(key+'_sha256')
     if not dep.is_file() or (expected and sha(dep)!=expected):issues.append('missing_or_changed_'+key)
     else:evidence.append({'path':str(dep),'sha256':sha(dep)})
   if m.get('scene'):
    scene=Path(m['scene']);record=deps.get(sha(scene),{});issues+=receipt(record,root)
    if record.get('license')!='generated-output':issues.append('uncleared_scene')
    if sha(scene)!=m.get('scene_sha256'):issues.append('changed_scene')
    evidence.append({'path':str(scene),'sha256':sha(scene)})
   mask=m.get('occlusion_mask')
   if mask:
    path=Path(mask['path'])
    if not path.is_file() or sha(path)!=mask['sha256']:issues.append('changed_occlusion_mask')
    else:evidence.append({'path':str(path),'sha256':sha(path)})
   ref=Path(capture.get('reference_path',root/'captures'/f'{identifier}.reference.json'))
   if ref.is_file():evidence.append({'path':str(ref),'sha256':sha(ref)})
   else:issues.append('missing_capture_reference')
   label_status='source-derived-capture-review-only-not-eval-admission'
  else:
   source_path=Path(meta.get('source_path','__missing__'));ref=Path(meta.get('reference_path','__missing__'))
   if not source_path.is_file():issues.append('missing_manual_source')
   else:
    source=json.loads(source_path.read_text());base=source_path.parent.parent
    rights=base/'sources/founding-docs-rights.html';transcript=base/'sources/bill-of-rights-transcript.html'
    if source.get('rights')!='public-domain-explicit-NARA-founding-downloads-statement' or source.get('credit')!='National Archives':issues.append('unverified_manual_rights')
    if not rights.is_file() or 'public domain' not in rights.read_text().lower():issues.append('missing_official_rights_proof')
    if not transcript.is_file() or sha(transcript)!=source.get('transcript_html_sha256'):issues.append('changed_official_transcript')
    for path in [source_path,rights,transcript]:
     if path.is_file():evidence.append({'path':str(path),'sha256':sha(path)})
    if sha(image)!=source.get('original_image',{}).get('sha256'):issues.append('changed_manual_original')
   if not ref.is_file() or sha(ref)!=meta.get('reference_sha256'):issues.append('changed_manual_reference')
   else:evidence.append({'path':str(ref),'sha256':sha(ref)})
   label_status='manual-silver-no-transcription-admission'
  out.append({'id':identifier,'rights_status':'evidence-ready' if not issues else 'blocked','issues':issues,'artifacts':evidence,'label_status':label_status,'source_group':meta.get('source_cluster'),'public_release':False})
 report={'schema':'frozen-layout-publication-audit-v1','createdAt':datetime.now(timezone.utc).isoformat(),'candidateManifest':{'path':str(frozen),'sha256':sha(frozen)},'dependencyClearances':{'path':str(publication/'DEPENDENCY-CLEARANCES.json'),'sha256':sha(publication/'DEPENDENCY-CLEARANCES.json')},'nativeAudit':{'path':str(publication/'PUBLISH-MANIFEST.json'),'sha256':sha(publication/'PUBLISH-MANIFEST.json')},'attribution':{'path':str(publication/'ATTRIBUTION.md'),'sha256':sha(publication/'ATTRIBUTION.md')},'candidate_count':len(out),'rights_ready_count':sum(not p['issues'] for p in out),'not_a_legal_guarantee':True,'not_eval_or_quality_admission':True,'public_release':False,'contribution_release':clearances['contribution_release'],'entries':out,'excluded_inspiration':'Magna Carta and other unverified external reference rasters are not in frozen allowlist.'}
 (publication/'FROZEN-PUBLISH-MANIFEST.json').write_text(json.dumps(report,indent=2)+'\n');return report

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root',type=Path);a=p.parse_args();r=finalize(a.root);print(json.dumps({'count':r['candidate_count'],'rights_ready':r['rights_ready_count'],'blocked':[(p['id'],p['issues']) for p in r['entries'] if p['issues']]},indent=2));raise SystemExit(int(r['rights_ready_count']!=r['candidate_count']))
