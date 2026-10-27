"""Independent checks of actual native table layout, original paints and persistence."""
from pathlib import Path
from datetime import datetime, timezone
import json
import sys
from PIL import Image
import pymupdf

HANDOFF=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-handoffs/a7-clean-r2')
OUT=Path('/home/dan/data/docslurp-evals/mixed-pdf-fools-gold-a7/round4')
sys.path.insert(0,str(HANDOFF/'generic'))
from support import FONTS,contains

def main():
    reports=[];persistence=[];misses=[]
    inspection=json.loads((OUT/'actual-original-inspection.json').read_text())
    for plan_path in sorted(OUT.glob('*.drawing-plan.json')):
        stem=plan_path.name.removesuffix('.drawing-plan.json');plan=json.loads(plan_path.read_text())
        author=json.loads((OUT/(stem+'.exact-authoring.json')).read_text());support=json.loads((OUT/(stem+'.support.json')).read_text())
        expected={g['id']:g for l in support['leaves'] for g in l['glyphs']}
        for producer in ['reportlab','writer']:
            native=stem+'-'+producer+'-original'
            glyphs=json.loads((OUT/'evidence'/(native+'.native-glyphs.json')).read_text())['glyphs']
            matches=json.loads((OUT/'evidence'/(native+'.glyph-match-details.json')).read_text())
            mapping={m['id']:glyphs[m['actualIndex']] for m in matches}
            cells=[];decimals=[];local=[]
            for cell in author['cells']:
                leaf=next(l for l in support['leaves'] if l['id']==cell['id'])
                gs=[mapping[g['id']] for g in leaf['glyphs'] if g['expectedInkPt'] is not None]
                assert all(not g['text'].isspace() for g in gs)
                text=''.join(g['text'] for g in gs)
                if text!=''.join(cell['literal'].split()):local.append({'id':cell['id'],'kind':'native cell content mismatch','actual':text})
                if any(c in text for c in ['|','\t','\n']):local.append({'id':cell['id'],'kind':'native markup in cell'})
                size=gs[0]['size'];font=FONTS['mono'];box=cell['physicalCellPt'];pad=cell['paddingPt']
                start=gs[0]['origin'][0];end=gs[-1]['origin'][0]+font.width(gs[-1]['text'],size)
                target=box[0]+pad if cell['alignment']=='left' else box[2]-pad-cell.get('rightInkInsetPt',0) if cell['alignment']=='right' else (box[0]+box[2])/2
                measured=start if cell['alignment']=='left' else end if cell['alignment']=='right' else (start+end)/2
                error=abs(measured-target)
                if error>.3:local.append({'id':cell['id'],'kind':'column alignment >0.3 pt','errorPt':error})
                overflow=[g for g in gs if not contains(box,g['ink'])]
                if overflow:local.append({'id':cell['id'],'kind':'actual glyph outside physical cell','glyphs':overflow})
                cells.append({'id':cell['id'],'row':cell['row'],'column':cell['column'],'alignment':cell['alignment'],
                              'actualStartPt':start,'actualEndAdvancePt':end,'targetAlignmentPt':target,'alignmentErrorPt':error,
                              'expectedHorizontalPaddingPt':pad,'fontSizePt':size,'meaningfulNativeText':text})
                if cell['column']==3 and cell['row']>=(2 if author['classId']=='E2' else 1):
                    decimals.extend(g['origin'][0] for g in gs if g['text']=='.')
            spread=max(decimals)-min(decimals) if decimals else 0
            if spread>.15:local.append({'kind':'decimal alignment spread','spreadPt':spread})
            with pymupdf.open(OUT/(native+'.pdf')) as doc:
                fills=[d for d in doc[0].get_drawings() if d.get('fill')==(1,1,1)]
                if fills:local.append({'kind':'unexpected white fills','count':len(fills)})
            bars=[];image=Image.open(OUT/'evidence'/(native+'-full-300.png')).convert('RGB')
            for bar in [o for o in plan['objects'] if o['id'].endswith('math.rule.bar')]:
                (x,y),(r,_)=bar['pointsPt'];tested=0;dark=0
                for xx in range(round(x*300/72)+2,round(r*300/72)-1):
                    tested+=1
                    dark+=any(max(image.getpixel((xx,yy)))<170 for yy in range(round(y*300/72)-2,round(y*300/72)+3))
                bars.append({'id':bar['id'],'interiorPixelColumns':tested,'columnsWithStrokeInk':dark})
                if tested!=dark:local.append({'kind':'interrupted original fraction stroke',**bars[-1]})
            original=next(r for r in inspection['pdfs'] if Path(r['pdf']).stem==native)
            if not original['exactGlyphMultiset'] or original['rawRepeatedNativeGlyphOperations']:local.append({'kind':'original glyph population/duplicate operation failure'})
            reports.append({'familyId':plan['familyId'],'producer':producer,'cells':cells,'decimalAlignmentSpreadPt':spread,
                            'whiteFillCount':len(fills),'fractionStrokeProbes':bars,'misses':local})
            misses.extend(local)
        a=json.loads((OUT/(stem+'-writer-original.readback-before.json')).read_text())
        b=json.loads((OUT/(stem+'-writer-original.readback-reloaded.json')).read_text())
        am={o['identity']:o for o in a['objects']};bm={o['identity']:o for o in b['objects']}
        local=[]
        if set(am)!=set(bm) or set(bm)!=set(b['expectedObjectIds']):local.append({'kind':'stable object identity changed'})
        changes=[{'id':id,'before':am[id]['properties'],'after':bm[id]['properties']} for id in am if am[id]['properties']!=bm[id]['properties']]
        if changes:local.append({'kind':'realized native properties changed on persistence','changes':changes})
        if any(not o['container']['membership'] for o in a['objects']+b['objects']):local.append({'kind':'actual DrawPage collection membership missing'})
        if any(o['properties']['AnchorPageNo']!=1 for o in a['objects']+b['objects']):local.append({'kind':'wrong actual page anchor'})
        if not all(t['parent']['bodyMembership'] for t in a['tables']+b['tables']):local.append({'kind':'actual native table body ownership missing'})
        if a['tables']!=b['tables']:local.append({'kind':'actual table state changed across ODT persistence'})
        for table in a['tables']+b['tables']:
            for id,value in table['cells'].items():
                if '|' in value or '\t' in value:local.append({'kind':'markup in actual editable cell','id':id})
            for id,value in table['cellProperties'].items():
                left=value['cell']['LeftBorderDistance']*72/2540;right=value['cell']['RightBorderDistance']*72/2540
                if abs(left-4)>.03 or abs(right-4)>.03:local.append({'kind':'native cell inset mismatch','id':id,'leftPt':left,'rightPt':right})
        odt=next(o for o in inspection['editableWriter'] if Path(o['odt']).stem==stem+'-writer-original')
        # Read structural parents from actual persisted XML; never infer them from null proxies.
        if not odt['tableAncestry'] or not odt['tableAncestry'][0]['tag'].endswith('}text'):local.append({'kind':'persisted table is not body-owned','ancestry':odt['tableAncestry']})
        if odt['misses']:local.extend(odt['misses'])
        persistence.append({'familyId':plan['familyId'],'actualPageCountBefore':a['pageCount'],'actualPageCountAfter':b['pageCount'],
                            'objectCount':len(am),'stableIdentities':set(am)==set(bm),'realizedPropertyChanges':changes,
                            'actualTableBodyMembership':True,'tableAncestryFromSavedXML':odt['tableAncestry'],
                            'rawParentApiUnavailable':[o['identity'] for o in b['objects'] if 'unavailable' in o['rawParentApi']],
                            'equivalentOwnershipEvidence':'actual remote-object membership in document DrawPage before and after reload plus saved XML structural parents; no body fallback from null Anchor.Text',
                            'misses':local})
        misses.extend(local)
    (OUT/'actual-table-layout-and-persistence.json').write_text(json.dumps({'observedAtUtc':datetime.now(timezone.utc).isoformat(),
        'tables':reports,'persistence':persistence,'misses':misses,'noDeduplicationOrRewrite':True,
        'limits':'Positive per-glyph ink probes and fraction-row probes are not a complete glyph-mask conservation certificate; independent review remains required.'},indent=2)+'\n')
    print('Actual native layout/persistence findings:',len(misses))
    for r in reports:print(r['familyId'],r['producer'],'cell count',len(r['cells']),'decimal spread',r['decimalAlignmentSpreadPt'],'findings',len(r['misses']))

if __name__=='__main__':main()
