#!/usr/bin/env python3
"""Derive a clean-acquisition view of an existing frozen corpus; no new evidence/images."""
import argparse
from collections import Counter,defaultdict
from datetime import datetime,timezone
import json
from pathlib import Path
from publish_audit import sha

REQUIRED={'digital','born-digital','aligned'}
DEGRADED={'picture','scanned','perspective','rotated','warped','skewed','cropped','occluded','low-res','blurry','low-lighting','underexposed','shadow','glare','noise','low-contrast','uneven-lighting'}


def choose(rows,conditions):
 groups=defaultdict(set)
 for row in rows:
  group=row.get('metadata',{}).get('source_cluster')
  if not group:raise ValueError('Missing locked source group: '+row['id'])
  groups[group].add(row['split'])
 if any(len(splits)>1 for splits in groups.values()):raise ValueError('Original source group crosses splits')
 selected=[];excluded=[]
 for row in rows:
  condition=conditions[row['id']]
  tags={a['tag'] for a in condition['assertions'] if a['scope']=={'kind':'page','id':row['id']}}
  missing=REQUIRED-tags;bad=tags&DEGRADED
  if condition.get('category')=='native' and not missing and not bad:selected.append(row)
  else:excluded.append({'id':row['id'],'category':condition.get('category'),'missing_positive_evidence':sorted(missing),'declared_degradation':sorted(bad)})
 return selected,excluded


def build(root,output):
 frozen=root/'frozen-v2/candidates.jsonl';index_path=root/'tags/frozen-index.json'
 index=json.loads(index_path.read_text())
 if index['candidateManifest']['sha256']!=sha(frozen):raise ValueError('Condition index does not match frozen corpus')
 rows=[json.loads(line) for line in frozen.read_text().splitlines() if line.strip()];conditions={};supports=[]
 for record in index['entries']:
  path=Path(record['path'])
  if sha(path)!=record['sha256']:raise ValueError('Condition sidecar changed: '+record['id'])
  condition=json.loads(path.read_text())
  for artifact in condition['artifacts']:
   if sha(Path(artifact['path']))!=artifact['sha256']:raise ValueError('Stale condition source evidence: '+record['id'])
  conditions[record['id']]=condition
  supports.append({'id':record['id'],'condition_path':str(path),'condition_sha256':sha(path),'artifacts':condition['artifacts']})
 selected,excluded=choose(rows,conditions);output.mkdir(parents=True,exist_ok=True)
 manifests={}
 for name,subset in [('candidates',selected),('dev',[r for r in selected if r['split']=='dev']),('holdout',[r for r in selected if r['split']=='holdout'])]:
  path=output/(name+'.jsonl');path.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in subset));manifests[name]={'path':str(path),'sha256':sha(path),'count':len(subset)}
 support_by={s['id']:s for s in supports};receipt={'schema':'common-clean-derived-slice-v1','createdAt':datetime.now(timezone.utc).isoformat(),'source_manifest':{'path':str(frozen),'sha256':sha(frozen)},'condition_index':{'path':str(index_path),'sha256':sha(index_path)},'derived_existing_corpus':True,'new_independent_set':False,'traffic_representative':False,'traffic_clean_fraction_hypothesis':'99% is a user hypothesis, not measured by this slice.','selection':{'required_positive_page_conditions':sorted(REQUIRED),'excluded_declared_page_conditions':sorted(DEGRADED),'category':'native','unknown_quality':'No condition absence is treated as proof of perfect quality. Selection is source-construction evidence only.','content_complexity':'Not a selection criterion; dense columns, math, multilingual type, tables and pictures may remain.'},'manifests':manifests,'groups':dict(Counter(r['metadata']['source_cluster'] for r in selected)),'original_split_counts':dict(Counter(r['split'] for r in selected)),'selected_evidence':[support_by[r['id']] for r in selected],'content_label_inventory':dict(Counter(region['label'] for row in selected for region in row.get('regions',[]))),'excluded':excluded,'limitations':['No new raster/source/annotation files generated or modified.','Original split and source clusters preserved exactly; no held-out model execution or inspection of predictions.','This is an overlapping stratified view of the frozen32, not independent validation evidence.','Clean acquisition does not imply easy layout or correct extraction.','No actual perfect-scanner originals newly added; selected pages are deliberately authored synthetic born-digital originals.','No production routing heuristic or fixture-specific branch is introduced.']}
 (output/'RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n');return receipt

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('root',type=Path);p.add_argument('--output',type=Path);a=p.parse_args();s=build(a.root,a.output or a.root/'common-clean-v1');print(json.dumps({'counts':s['original_split_counts'],'selected':sum(s['original_split_counts'].values()),'groups':len(s['groups']),'receipt':str((a.output or a.root/'common-clean-v1')/'RECEIPT.json')},indent=2))
