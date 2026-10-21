#!/usr/bin/env python3
"""Render and freeze a separately authored ordinary-document evaluation candidate pool.

No detector predictions are read. Source contracts precede raster publication through
Page.finalize. A freeze is source integrity, not visual or model-quality approval.
"""
import argparse, collections, hashlib, itertools, json, sys
from pathlib import Path
from PIL import Image, ImageDraw
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from corpus_v2.page import sha


def dump(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')


def render(root):
    from common_corpus import editorial,business
    editorial_pages=editorial.build();business_pages=business.build()
    pages=editorial_pages+business_pages
    source_modules={id(page):'editorial' for page in editorial_pages}|{id(page):'business' for page in business_pages}
    if len(pages)!=12 or len({p.id for p in pages})!=12:raise ValueError('Expected12 distinct authored page IDs')
    rows=[]
    for page in pages:
        page.source['common_corpus']={**page.source.get('common_corpus',{}),'scope':'fresh ordinary-document source composition; no V2 image/source reuse',
            'template_instance':page.source.get('template_instance',page.source.get('provenance',{}).get('source_style_family',page.source['document_id'])),
            'contribution':'Original assistant-authored fictional prose/data and page layout; code/fonts retain separate rights',
            'reading_order':'unvalidated-do-not-score'}
        row=page.finalize(root)
        row['metadata']['template_instance']=page.source['common_corpus']['template_instance']
        row['metadata']['corpus']='layout-common-v1'
        row['metadata']['source_module']=source_modules[id(page)]
        rows.append(row)
    (root/'manifest.jsonl').write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n' for row in rows))
    sheet=Image.new('RGB',(1600,1800),'#d9dfdf');draw=ImageDraw.Draw(sheet)
    for n,row in enumerate(rows):
        im=Image.open(root/row['image_path']);im.thumbnail((375,545))
        x=(n%4)*400+12;y=(n//4)*600+10;sheet.paste(im,(x,y));draw.text((x,y+555),row['id'].replace('common-',''),fill='#192929')
    sheet.save(root/'contact-sheet.jpg',quality=93)
    return rows


def validate(root,rows):
    artifacts=[];warnings=[]
    for row in rows:
        meta=row['metadata'];source=root/meta['source_path'];reference=root/meta['reference_path']
        paths={'image':root/row['image_path'],'source':source,'reference':reference,
            'markdown':root/meta['expected_markdown']['path'],'prose_contract':root/meta['prose_contract']['path'],
            'confidence':root/meta['annotation_confidence']['receipt_path']}
        hashes={key:sha(path) for key,path in paths.items()}
        for key,expected in [('image',meta['image_sha256']),('source',meta['source_sha256']),('markdown',meta['expected_markdown']['sha256']),('prose_contract',meta['prose_contract']['sha256'])]:
            if hashes[key]!=expected:raise ValueError((row['id'],'artifact hash mismatch',key))
        src=json.loads(source.read_text());ref=json.loads(reference.read_text());confidence=json.loads(paths['confidence'].read_text())
        for key,field in [('image','imageSha256'),('source','sourceSha256'),('reference','referenceSha256')]:
            if confidence['artifacts'][field]!=hashes[key]:raise ValueError('Unbound confidence receipt')
        if ref['regions']!=row['regions']:raise ValueError('Manifest/reference geometry divergence')
        cells=0
        for region in row['regions']:
            x0,y0,x1,y1=region['bbox']
            if not (0<=x0<x1<=row['width'] and 0<=y0<y1<=row['height']):raise ValueError('Region outside image')
            if region['label']=='table':
                data=region['attributes'].get('cells')
                if not data:raise ValueError('Table missing cell references')
                if len({(c['row'],c['column']) for c in data})!=len(data):raise ValueError('Duplicate table coordinates')
                cells+=len(data)
        lines=[]
        for block in src['text_blocks']:
            if not block.get('parent_region_id') or len(block['line_texts'])!=len(block['line_boxes']):raise ValueError('Missing prose/line reference')
            lines.extend((block['id'],box) for text,box in zip(block['line_texts'],block['line_boxes']) if text.strip())
        for i,(aid,a) in enumerate(lines):
            for bid,b in lines[i+1:]:
                if aid==bid:continue
                overlap=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
                if overlap>4:warnings.append({'id':row['id'],'type':'native_glyph_lines_overlap','blocks':[aid,bid],'intersection_px2':round(overlap,2)})
        artifacts.append({'id':row['id'],'artifactHashes':hashes,'regionCount':len(row['regions']),'tableCellCount':cells,'nativeLineCount':len(lines)})
    report={'schema':'common-source-contract-qa-v1','modelBlind':True,'checked':'source/reference/image/MD/prose/confidence hashes, finite bounds, table coordinates, native glyph line overlap',
            'counts':{'pages':len(rows),'regions':sum(x['regionCount'] for x in artifacts),'tableCells':sum(x['tableCellCount'] for x in artifacts)},
            'artifacts':artifacts,'warnings':warnings,'independentSemanticOrTranscriptionReview':False,'visualReview':'separate full-page review required'}
    dump(root/'source-contract-qa.json',report)
    return report


def rights(root,rows):
    publication=root/'publication'
    policy_path=publication/'CONTRIBUTION-RELEASE-CANDIDATE.json'
    font_evidence=publication/'font-license-evidence.json'
    if not policy_path.exists() or not font_evidence.exists():raise ValueError('Missing staged contribution/font provenance receipts')
    policy=json.loads(policy_path.read_text());font_license=json.loads(font_evidence.read_text())
    if policy.get('status')!='staged-reviewable-candidate-not-public-release':raise ValueError('Unexpected contribution policy scope')
    for entry in font_license['evidence']:
        if sha(entry['path'])!=entry['sha256']:raise ValueError('Changed license evidence')
    entries=[]
    for row in rows:
        src_path=root/row['metadata']['source_path'];source=json.loads(src_path.read_text())
        declaration=source.get('provenance',{}).get('rights')
        if not declaration:raise ValueError('Missing source authorship declaration')
        if any(command['op']=='image' for command in source['commands']):raise ValueError('Unexpected image insert requires independent asset rights audit')
        fonts=[]
        for face,record in source['font_provenance'].items():
            if sha(record['path'])!=record['sha256']:raise ValueError('Changed font dependency')
            if Path(record['path']).parent!=Path('/usr/share/fonts/gsfonts'):raise ValueError('Unreviewed font family')
            fonts.append({'face':face,**record,'distribution':'rendered pixels only; font binary excluded'})
        entries.append({'id':row['id'],'sourceSha256':sha(src_path),'imageSha256':row['metadata']['image_sha256'],
                        'authorshipDeclaration':declaration,'fonts':fonts,'status':'staged-original-contribution-evidence-ready'})
    report={'schema':'common-dataset-rights-receipt-v1','publicRelease':False,'notALegalGuarantee':True,
            'contributionPolicy':{'path':str(policy_path),'sha256':sha(policy_path)},
            'fontEvidence':{'path':str(font_evidence),'sha256':sha(font_evidence)},'entries':entries,
            'exclusions':['Repository generator code retains repository license.','No font binaries or third-party page/image assets included.'],
            'scope':'Original synthetic common document text, fictional data, layout and source-derived annotations, only to extent rights held.'}
    dump(publication/'RIGHTS-RECEIPT.json',report)
    return report


def freeze(root,rows,qa):
    if qa['warnings']:raise ValueError('Resolve glyph-overlap warnings before freeze')
    # Group actual documents and declared template instances; font/Page helper reuse is not a source instance.
    parent={r['id']:r['id'] for r in rows};seen={};joins=[]
    def find(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    for row in rows:
        m=row['metadata']
        for key,value in [('document',m['document_id']),('template_instance',m['template_instance']),('image',m['image_sha256'])]:
            token=(key,value)
            if token in seen:
                a,b=find(row['id']),find(seen[token]);parent[max(a,b)]=min(a,b);joins.append({'kind':key,'value':value,'members':[row['id'],seen[token]]})
            else:seen[token]=row['id']
    groups=collections.defaultdict(list)
    for row in rows:groups[find(row['id'])].append(row['id'])
    groups={k:sorted(v) for k,v in groups.items()};labels={k:{reg['label'] for row in rows if row['id'] in v for reg in row['regions']} for k,v in groups.items()}
    if not 10<=len(groups)<=12:raise ValueError('Expected10–12 independent source/template groups')
    all_labels=set().union(*labels.values());repeat={label for label in all_labels if sum(label in x for x in labels.values())>1};options=[]
    for n in range(1,len(groups)):
        for held in itertools.combinations(sorted(groups),n):
            if sum(len(groups[k]) for k in held)!=4:continue
            train=set().union(*(labels[k] for k in groups if k not in held));test=set().union(*(labels[k] for k in held))
            if train!=all_labels:continue
            rank=(len(repeat-test),abs(sum('business' in str(next(r for r in rows if r['id']==groups[k][0])['metadata'].get('source_module','')) for k in held)-2),len(held)!=4,held)
            options.append((rank,set(held)))
    if not options:raise ValueError('No group-closed8/4 split preserving development labels')
    held=min(options,key=lambda x:x[0])[1];out=root/'frozen-common';out.mkdir(exist_ok=True)
    for row in rows:
        group=find(row['id']);row['split']='holdout' if group in held else 'dev';row['metadata']['source_cluster']=group
        for key in ['source_path','reference_path']:row['metadata'][key]=str((root/row['metadata'][key]).resolve())
        row['image_path']=str((root/row['image_path']).resolve())
    encoded={f'{split}.jsonl':''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows if split=='candidates' or r['split']==split) for split in ['dev','holdout','candidates']}
    lockpath=out/'LOCK.json'
    if lockpath.exists():
        lock=json.loads(lockpath.read_text())
        for name,value in encoded.items():
            if hashlib.sha256(value.encode()).hexdigest()!=lock['outputs'][name]:raise ValueError('Frozen common corpus changed')
        return lock
    for name,value in encoded.items():(out/name).write_text(value)
    receipt={'schema':'common-model-blind-source-split-v1','groups':groups,'source_to_cluster':{i:k for k,v in groups.items() for i in v},'join_receipts':joins,
            'assignment':{k:'holdout' if k in held else 'dev' for k in groups},'counts':{'dev':8,'holdout':4,'sourceGroups':len(groups)},
            'labelCounts':{s:dict(collections.Counter(reg['label'] for r in rows if r['split']==s for reg in r['regions'])) for s in ['dev','holdout']},
            'policy':'Model-blind exhaustive whole-document/template/image grouping; exact8dev4holdout; retain all labels in dev, maximize repeated labels in holdout; no model outcomes read',
            'sourceManifestSha256':sha(root/'manifest.jsonl'),'sourceContractQaSha256':sha(root/'source-contract-qa.json'),'rightsReceiptSha256':sha(root/'publication/RIGHTS-RECEIPT.json'),
            'limitations':['Small original synthetic ordinary-document pool, not independent real-world evidence.','Reading order and heading rank unvalidated; no Markdown-content evaluation admission.','Singleton feature gaps are explicit; source confidence is not calibrated probability.']}
    dump(out/'split-receipt.json',receipt)
    lock={'schema':'layout-common-source-lock-v1','outputs':{n:sha(out/n) for n in encoded},'splitReceiptSha256':sha(out/'split-receipt.json'),'sourceQaSha256':sha(root/'source-contract-qa.json'),'generatorSha256':sha(__file__),'admission':'source lock only; model-blind visual review/integrity separate'}
    dump(lockpath,lock);return lock


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--render',action='store_true');p.add_argument('--freeze',action='store_true');a=p.parse_args();root=a.root.resolve();root.mkdir(parents=True,exist_ok=True)
    if a.render and (root/'frozen-common/LOCK.json').exists():raise ValueError('Cannot rerender locked sources')
    rows=render(root) if a.render else [json.loads(s) for s in (root/'manifest.jsonl').read_text().splitlines()]
    qa=validate(root,rows);rights(root,rows);result={'qaCounts':qa['counts'],'warnings':qa['warnings']}
    if a.freeze:result['lock']=freeze(root,rows,qa)
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
