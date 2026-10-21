#!/usr/bin/env python3
"""Metadata-only condition assertions; never infer image quality from content or age."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

TAXONOMY = {
 'digital': ('acquisition', ['page']), 'scanned': ('acquisition', ['page']), 'picture': ('acquisition', ['page']),
 'born-digital': ('source-origin', ['page']), 'synthetic': ('synthesis', ['page']),
 'aligned': ('page-alignment', ['page']), 'skewed': ('page-alignment', ['page']),
 'perspective': ('page-projection', ['page']), 'rotated': ('page-rotation', ['page']), 'warped': ('page-shape', ['page']),
 'low-res': ('resolution', ['page','region','row','cell']), 'blurry': ('sharpness', ['page','region','row','cell']),
 'low-lighting': ('exposure', ['page','region']), 'shadow': ('illumination', ['page','region']),
 'glare': ('illumination', ['page','region']), 'uneven-lighting': ('illumination', ['page','region']),
 'noise': ('noise', ['page','region']), 'low-contrast': ('contrast', ['page','region']),
 'cropped': ('extent', ['page','region','table','row','cell']), 'occluded': ('visibility', ['page','region','table','row','cell']),
 'borderless': ('table-rules', ['table']), 'bordered': ('table-rules', ['table']), 'mixed-rules': ('table-rules', ['table']),
 'header-repeated': ('table-header', ['table']), 'continues': ('table-continuation', ['table']),
 'partial-row': ('row-extent', ['row']), 'truncated-cell': ('cell-extent', ['cell']),
 'empty-cell': ('cell-content', ['cell']), 'missing-cell': ('cell-content', ['cell']),
 'row-aligned': ('row-alignment', ['row']), 'row-misaligned': ('row-alignment', ['row']),
}
EXCLUSIVE_FACETS = {'acquisition','page-alignment','table-rules','cell-content','row-alignment'}
SCORES = [0, .25, .5, .75, 1]


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def assertion(tag, scope, evidence, basis, confidence=.5):
 return {'tag':tag,'facet':TAXONOMY[tag][0],'scope':scope,'evidence':evidence,'confidence':confidence,'basis':basis,'actor':'coverage_curator','confidenceMeaning':'ordinal-evidence-not-probability'}


def validate(assertions):
 seen=defaultdict(set)
 for a in assertions:
  if a['tag'] not in TAXONOMY: raise ValueError('Unknown tag '+a['tag'])
  facet, scopes=TAXONOMY[a['tag']]
  if a['facet']!=facet or a['scope']['kind'] not in scopes: raise ValueError('Invalid tag facet/scope')
  if a['confidence'] not in SCORES or not a['basis'] or not a['evidence']: raise ValueError('Missing grounded assertion evidence')
  key=(facet,json.dumps(a['scope'],sort_keys=True));seen[key].add(a['tag'])
  if facet in EXCLUSIVE_FACETS and len(seen[key])>1:raise ValueError('Contradictory tags in same facet and scope: '+str(key))
 for (_,scope_json),tags in [(key,value) for key,value in seen.items()]:
  scope=json.loads(scope_json)
  same_scope={a['tag'] for a in assertions if a['scope']==scope}
  if scope['kind']=='page' and 'aligned' in same_scope and same_scope.intersection({'perspective','rotated','skewed'}):
   raise ValueError('Aligned native page conflicts with transformed page conditions in same scope')
 return True


def inherit_page(assertions, child_scope):
 """Preserve scope: inherited page conditions remain page-context, never row facts."""
 own=[dict(a) for a in assertions if a['scope']==child_scope]
 context=[{**a,'inheritedFrom':a['scope'],'appliesAs':'page-context-only'} for a in assertions if a['scope']['kind']=='page']
 return {'assertions':own,'pageContext':context}


def table_assertions(regions, evidence, commands=None):
 out=[]
 for r in regions:
  if r.get('label')!='table':continue
  attrs=r.get('attributes',{});scope={'kind':'table','id':r['id']};cells=attrs.get('cells',[])
  if attrs.get('border') is True:out.append(assertion('bordered',scope,evidence,'Source explicitly draws complete cell borders.'))
  elif commands is not None:
   b=r['bbox'];rules=[c for c in commands if c.get('op')=='line' and len(c.get('xy',[]))==4 and b[0]<=c['xy'][0]<=b[2] and b[0]<=c['xy'][2]<=b[2] and b[1]<=c['xy'][1]<=b[3] and b[1]<=c['xy'][3]<=b[3]]
   boxes=[c for c in commands if c.get('op')=='rect' and c.get('outline') and c['bbox'][0]>=b[0] and c['bbox'][2]<=b[2] and c['bbox'][1]>=b[1] and c['bbox'][3]<=b[3]]
   if rules or boxes:out.append(assertion('mixed-rules',scope,evidence,'Source commands contain table rules; border=False alone does not mean borderless.'))
   elif cells:out.append(assertion('borderless',scope,evidence,'Explicit cell table with no line or outlined-rectangle rule commands inside its bounds.'))
  if attrs.get('continuation_id'):out.append(assertion('continues',scope,evidence,'Explicit authored continuation_id links table parts.'))
  if attrs.get('header_repeated') is True:out.append(assertion('header-repeated',scope,evidence,'Source explicitly declares repeated table header.'))
  partial_rows=set()
  for cell in cells:
   cs={'kind':'cell','id':f"{r['id']}/row/{cell['row']}/column/{cell['column']}"}
   if cell.get('truncated') is True:
    out.append(assertion('truncated-cell',cs,evidence,'Explicit crop metadata marks cell truncated.'));partial_rows.add(cell['row'])
   if cell.get('text')=='':out.append(assertion('empty-cell',cs,evidence,'Source explicitly contains an empty string; null/missing is unknown, not empty.'))
  for row in sorted(partial_rows):out.append(assertion('partial-row',{'kind':'row','id':f"{r['id']}/row/{row}"},evidence,'At least one cell in this row explicitly marked truncated.'))
 return out


def package(identifier, category, artifacts, assertions, unknown):
 validate(assertions)
 return {'schema':'layout-condition-tags-v1','id':identifier,'category':category,'createdAt':datetime.now(timezone.utc).isoformat(),'artifacts':artifacts,'tags':sorted({a['tag'] for a in assertions}),'assertions':assertions,'unknown':unknown,'limitations':['Metadata only; tag absence means unknown or not asserted, never false.','Page picture tag identifies acquisition/composite context, not an embedded photo region.','Confidence is ordinal evidence strength, not probability or extraction accuracy.']}


def artifact(path, role):return {'role':role,'path':str(path),'sha256':sha(path)}


def backfill(root, historical=None):
 out=root/'tags';out.mkdir(exist_ok=True);results=[]
 for path in sorted((root/'sources').glob('*.json')):
  source=json.loads(path.read_text());identifier=source['id'];arts=[artifact(path,'source')]
  for folder,suffix,role in [('images','png','image'),('references','json','reference')]:
   p=root/folder/f'{identifier}.{suffix}'
   if p.is_file():arts.append(artifact(p,role))
  ev=[arts[0]];a=[];scope={'kind':'page','id':identifier}
  if source.get('provenance',{}).get('kind') in {'deliberately-authored-editorial-composition','original-fictional-period-menu-composition'}:
   for tag in ['digital','born-digital','synthetic','aligned']:a.append(assertion(tag,scope,ev,'Native authored source commands rendered directly on upright page canvas, without capture transform.'))
  a+=table_assertions(source.get('regions',[]),ev,source.get('commands',[]))
  results.append(package(identifier,'native',arts,a,[{'facet':'image-quality','reason':'No page-level measured quality or independent condition adjudication; embedded asset lighting does not describe native page acquisition.'}]))
 for path in sorted((root/'captures').glob('*.row.json')):
  row=json.loads(path.read_text());identifier=row['id'];meta=row.get('metadata',{});arts=[artifact(path,'capture-row')]
  image=Path(row['image_path']);image=image if image.is_absolute() else root/image
  if image.is_file():arts.append(artifact(image,'image'))
  ev=[arts[0]];a=[];scope={'kind':'page','id':identifier};kind=meta.get('kind')
  a.append(assertion('synthetic',scope,ev,'Capture recipe derives from an authored synthetic source.'))
  if kind=='synthetic-photographic-print-composite':
   a.append(assertion('picture',scope,ev,'Explicit photographic print composite, not an actual camera photograph.'))
   if meta.get('source_to_capture'):a.append(assertion('perspective',scope,ev,'Source-to-capture homography and calibrated quadrilateral recorded.'))
   if meta.get('calibration',{}).get('occlusion_polygons'):a.append(assertion('occluded',scope,ev,'Manual foreground silhouette records hand occlusion; not character-level visibility.'))
   if meta.get('calibration',{}).get('lighting'):a.append(assertion('uneven-lighting',scope,ev,'Calibrated recipe records directional/mixed lighting: '+meta['calibration']['lighting']))
  elif meta.get('crop_box_source_pixels'):
   for tag in ['digital','cropped','aligned']:a.append(assertion(tag,scope,ev,'Deterministic digital crop recipe; identity source transform, not proof of an actual scanner.'))
  a+=table_assertions(row.get('regions',[]),ev)
  results.append(package(identifier,'capture-variant',arts,a,[{'facet':'sharpness/exposure/resolution','reason':'No thresholded measurement or verified condition assertion. No blur/low-light/low-res guess from recipe aesthetics.'}]))
 if historical:
  manifest=historical/'source-manifest.json';data=json.loads(manifest.read_text())
  for record in data.get('assets',[]):
   path=Path(record['path']);arts=[artifact(manifest,'historical-source-manifest'),artifact(path,'image')]
   results.append(package(record['id'],'historical-reference',arts,[],[{'facet':'acquisition/alignment/quality','reason':'Archive reproduction known; actual scanner/camera, orientation measurement and quality thresholds not established by this receipt. Historical age/ink/paper color do not establish blur or low lighting.'}]))
 for result in results:(out/(result['id']+'.conditions.json')).write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
 summary={'schema':'layout-condition-tags-index-v1','createdAt':datetime.now(timezone.utc).isoformat(),'metadataOnly':True,'count':len(results),'categories':dict(__import__('collections').Counter(r['category'] for r in results)),'entries':[{'id':r['id'],'path':str(out/(r['id']+'.conditions.json')),'sha256':sha(out/(r['id']+'.conditions.json')),'tags':r['tags']} for r in results]}
 (out/'index.json').write_text(json.dumps(summary,indent=2)+'\n');return summary


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('root',type=Path);p.add_argument('--historical',type=Path);args=p.parse_args();print(json.dumps(backfill(args.root,args.historical),indent=2))

if __name__=='__main__':main()
